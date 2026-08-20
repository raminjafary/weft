import { createServer, connect, type Socket } from 'node:net'

export interface LatencyOptions {
  /** Round-trip time in milliseconds. Half is applied in each direction. */
  rttMs: number
}

export interface LatencyProxy {
  url: string
  close(): Promise<void>
}

function delayedPipe(from: Socket, to: Socket, delayMs: number): void {
  const timers = new Set<NodeJS.Timeout>()
  from.on('data', (chunk: Buffer) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (!to.destroyed) to.write(chunk)
    }, delayMs)
    timers.add(timer)
  })
  from.on('end', () => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (!to.destroyed) to.end()
    }, delayMs)
    timers.add(timer)
  })
  from.on('close', () => {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
  })
  from.on('error', () => to.destroy())
}

/**
 * A TCP proxy that holds every chunk for half the RTT in each direction. Loopback has
 * no network in it, and without one an early flush is indistinguishable from a late one:
 * the whole point of flushing the shell first is that its bytes are already travelling
 * while the slow data is still being fetched.
 *
 * This models latency only. It does not model bandwidth, loss, or congestion control,
 * so it understates what a real slow link does to a large response.
 */
export async function withLatency(target: string, options: LatencyOptions): Promise<LatencyProxy> {
  const upstream = new URL(target)
  const oneWay = Math.max(0, options.rttMs / 2)

  const server = createServer((client) => {
    const server2 = connect({ host: upstream.hostname, port: Number(upstream.port) }, () => {
      delayedPipe(client, server2, oneWay)
      delayedPipe(server2, client, oneWay)
    })
    server2.on('error', () => client.destroy())
    client.on('error', () => server2.destroy())
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address === 'string' || address === null) throw new Error('E_NO_ADDRESS')

  return {
    url: `http://127.0.0.1:${address.port}${upstream.pathname}${upstream.search}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}
