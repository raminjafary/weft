import { createServer, connect, type Socket } from 'node:net'

/**
 * The maximum segment size an Ethernet-sized path carries. Bandwidth, loss and the congestion
 * window are all per-packet effects, so the shaper needs a packet, and 1460 is the one a real
 * TCP connection over a 1500-byte MTU picks.
 */
const MSS = 1460

/** Initial congestion window, in packets. IW10 is what Linux has shipped since 2.6.38. */
const INITIAL_WINDOW = 10

export interface LinkOptions {
  /** Round-trip time in milliseconds. Half is applied in each direction. */
  rttMs: number
  /**
   * Link rate in kilobits per second, applied in each direction independently. Zero or absent
   * leaves the link infinitely fast, which is what loopback already is.
   */
  kbps?: number
  /**
   * Per-packet loss, as a percentage. A lost packet is retransmitted after an RTO and, because
   * TCP delivers in order, everything behind it waits — so loss costs a stall, not bytes.
   */
  lossPercent?: number
  /**
   * Seed for the loss draw. Fixed by default: a benchmark whose network differs run to run
   * cannot separate a change in the framework from a change in the weather.
   */
  seed?: number
}

export interface LinkProxy {
  url: string
  close(): Promise<void>
}

/** mulberry32. Seeded so two runs of the same command see the same losses in the same places. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Shaper {
  /**
   * When the byte stream up to and including this packet is delivered, on the same clock as
   * `arrivedAt` — a millisecond count from the moment the connection opened.
   */
  deliverAt(bytes: number, arrivedAt: number): number
}

/**
 * A one-direction model of a slow link: serialization, slow start, and in-order loss recovery.
 *
 * Three things decide when a packet lands, and the latest of them wins:
 *
 * - **Serialization.** The link can only put `kbps` on the wire per second, so a packet cannot
 *   start before the one ahead of it has finished. This is the term that makes a byte difference
 *   cost time: 18% more bytes is 18% more serialization, every time, on every packet.
 * - **Slow start.** A sender may not have more than a congestion window in flight, and the window
 *   starts at ten packets and doubles once per RTT. On a high-RTT link this dominates a short
 *   response entirely — the first ~14 KB are free, and the next ones cost a whole round trip.
 * - **Loss.** A dropped packet is retransmitted after an RTO, and TCP hands bytes to the
 *   application in order, so the receiver sees nothing behind the hole until it is filled. The
 *   window is halved, which is what makes one loss expensive for a while and not just once.
 *
 * What is still not modelled: the handshake, congestion avoidance after the first loss (the window
 * grows exponentially throughout), the receive window, ack clocking, competing flows, and bufferbloat.
 * The direction of every one of those errors is the same — a real slow link is worse than this one.
 */
function shaper(oneWayMs: number, rttMs: number, kbps: number, loss: number, draw: () => number): Shaper {
  const bytesPerMs = kbps > 0 ? (kbps * 1000) / 8 / 1000 : Infinity
  let wireFreeAt = 0
  let delivered = 0
  let windowBytes = INITIAL_WINDOW * MSS
  let windowRemaining = windowBytes
  let windowOpensAt = 0

  return {
    deliverAt(bytes: number, arrivedAt: number): number {
      // The link is idle until the sender has something to send: a packet that arrives during a
      // gap starts serializing on arrival, not where the previous burst left off.
      wireFreeAt = Math.max(wireFreeAt, arrivedAt)

      if (windowRemaining < bytes) {
        windowOpensAt = Math.max(windowOpensAt, wireFreeAt) + rttMs
        wireFreeAt = Math.max(wireFreeAt, windowOpensAt)
        windowBytes *= 2
        windowRemaining = windowBytes
      }
      windowRemaining -= bytes

      const serialization = bytesPerMs === Infinity ? 0 : bytes / bytesPerMs
      wireFreeAt += serialization
      let at = Math.max(delivered, wireFreeAt + oneWayMs)

      if (loss > 0 && draw() < loss) {
        // An RTO is at least one RTT and, on a fast link, floored by the minimum timer a real
        // stack uses. Everything behind the hole waits with it, which `delivered` carries forward.
        at += Math.max(rttMs, 200)
        windowBytes = Math.max(MSS * 2, windowBytes / 2)
        windowRemaining = Math.min(windowRemaining, windowBytes)
      }

      delivered = at
      return at
    },
  }
}

function shapedPipe(from: Socket, to: Socket, options: LinkOptions, seedOffset: number): void {
  const oneWay = Math.max(0, options.rttMs / 2)
  const kbps = options.kbps ?? 0
  const loss = Math.max(0, Math.min(1, (options.lossPercent ?? 0) / 100))
  const timers = new Set<NodeJS.Timeout>()

  const schedule = (delay: number, action: () => void): void => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      action()
    }, delay)
    timers.add(timer)
  }

  // With neither a rate nor loss there is nothing per-packet to model, and holding the whole chunk
  // for half the RTT is both cheaper and exactly what this proxy used to do.
  if (kbps === 0 && loss === 0) {
    from.on('data', (chunk: Buffer) => {
      schedule(oneWay, () => {
        if (!to.destroyed) to.write(chunk)
      })
    })
    from.on('end', () => {
      schedule(oneWay, () => {
        if (!to.destroyed) to.end()
      })
    })
  } else {
    const link = shaper(oneWay, options.rttMs, kbps, loss, random((options.seed ?? 1) + seedOffset))
    const origin = performance.now()
    let last = 0
    from.on('data', (chunk: Buffer) => {
      const arrivedAt = performance.now() - origin
      for (let offset = 0; offset < chunk.length; offset += MSS) {
        const packet = chunk.subarray(offset, Math.min(offset + MSS, chunk.length))
        last = link.deliverAt(packet.length, arrivedAt)
        schedule(Math.max(0, last - arrivedAt), () => {
          if (!to.destroyed) to.write(packet)
        })
      }
    })
    from.on('end', () => {
      schedule(Math.max(0, last - (performance.now() - origin)), () => {
        if (!to.destroyed) to.end()
      })
    })
  }

  from.on('close', () => {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
  })
  from.on('error', () => to.destroy())
}

/**
 * A TCP proxy that puts a network in front of a loopback server.
 *
 * Loopback has no network in it, and without one an early flush is indistinguishable from a late
 * one: the whole point of flushing the shell first is that its bytes are already travelling while
 * the slow data is still being fetched. Latency alone shows that. It does not show what a byte
 * difference costs — on an infinitely fast link, 18% more bytes is free — so a rate and a loss
 * probability are modelled too, and stated with the result.
 *
 * See {@link shaper} for exactly what is and is not in the model.
 */
export async function withLink(target: string, options: LinkOptions): Promise<LinkProxy> {
  const upstream = new URL(target)

  const server = createServer((client) => {
    const server2 = connect({ host: upstream.hostname, port: Number(upstream.port) }, () => {
      shapedPipe(client, server2, options, 0)
      shapedPipe(server2, client, options, 0x9e37)
    })
    server2.on('error', () => client.destroy())
    client.on('error', () => server2.destroy())
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address === 'string' || address === null)
    throw new Error(
      'E_NO_ADDRESS: the server reported no TCP address after listening, so nothing can be told where to connect',
    )

  return {
    url: `http://127.0.0.1:${address.port}${upstream.pathname}${upstream.search}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

/**
 * How the link a run was measured over should be described, so no report has to reconstruct it.
 */
export function describeLink(options: LinkOptions): string {
  if (options.rttMs <= 0 && !options.kbps && !options.lossPercent) {
    return 'loopback: no network was modelled'
  }
  const parts = [`${options.rttMs} ms RTT`]
  parts.push(options.kbps ? `${options.kbps} kbps each way` : 'unlimited bandwidth')
  parts.push(options.lossPercent ? `${options.lossPercent}% packet loss` : 'no loss')
  return parts.join(', ')
}
