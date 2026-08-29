import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import {
  createBinaryDecoder,
  createTextDecoder,
  encodeBinaryFrame,
  encodeStream,
  encodeTextFrame,
  preamble,
  type AnyFrame,
  type Frame,
} from '@weftjs/warp'
import type { ChannelBinding, ChannelHub, ChannelSink } from '@weftjs/kernel'
import { acceptWebSocket, type WebSocketConnection } from './node-websocket.ts'

/**
 * The four bindings the design names, over a real socket — and the one that needs no socket. Each
 * is a `ChannelSink`; the state machine above them does not know which it is talking to. See
 * `spec/kernel/transport.md`.
 */
export function streamSink(res: ServerResponse): ChannelSink {
  let open = true
  let saturated = false
  res.writeHead(200, {
    'content-type': 'application/warp',
    'cache-control': 'no-store',
    // Otherwise a reverse proxy buffers the whole thing.
    'x-accel-buffering': 'no',
  })
  res.flushHeaders()
  res.write(preamble())
  res.on('close', () => {
    open = false
  })
  // `write` returning false means the peer is not reading: recording it lets the hub close a
  // slow consumer instead of buffering for it.
  res.on('drain', () => {
    saturated = false
  })
  return {
    binding: 'stream',
    get open() {
      return open && !res.writableEnded
    },
    get saturated() {
      return saturated
    },
    send(frames) {
      if (!open) return
      // No preamble per frame: it went out with the headers, one stream for the channel's whole life.
      for (const f of frames) {
        if (!res.write(encodeBinaryFrame(f))) saturated = true
      }
    },
    close() {
      if (!open) return
      open = false
      // Ending an already-abandoned response produces ERR_INCOMPLETE_CHUNKED_ENCODING.
      if (!res.writableEnded && !res.destroyed) res.end()
    },
  }
}

/** A sink over an event stream, for a client whose upgrade was refused. */
export function sseSink(res: ServerResponse): ChannelSink {
  let open = true
  let saturated = false
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.flushHeaders()
  res.write(': warp\n\n')
  res.on('close', () => {
    open = false
  })
  res.on('drain', () => {
    saturated = false
  })
  return {
    binding: 'sse',
    get open() {
      return open && !res.writableEnded
    },
    get saturated() {
      return saturated
    },
    send(frames) {
      if (!open) return
      // One frame per event: the text framing guarantees no interior newline.
      for (const f of frames) {
        if (!res.write(`data: ${encodeTextFrame(f)}\n\n`)) saturated = true
      }
    },
    close() {
      if (!open) return
      open = false
      if (!res.writableEnded && !res.destroyed) res.end()
    },
  }
}

/** A sink over a WebSocket. Reports saturation, which is what makes backpressure a close. */
export function socketSink(connection: WebSocketConnection): ChannelSink {
  // One preamble per connection, as its own message: a WebSocket delivers whole messages.
  connection.send(preamble())
  return {
    binding: 'socket',
    get open() {
      return connection.open
    },
    get saturated() {
      return connection.saturated
    },
    send(frames) {
      if (!connection.open) return
      for (const f of frames) connection.send(encodeBinaryFrame(f))
    },
    close(reason) {
      connection.close(1000, reason ?? 'closed')
    },
  }
}

/**
 * A sink that holds frames instead of writing them, for a binding whose downstream is a response
 * body not yet written. Taking the buffer rather than `receive`'s return value is what makes a
 * turn carry the same set a socket would have seen. No `saturated`: the peer of a turn is not
 * reading yet at all. See `spec/kernel/transport.md`.
 */
export function turnSink(): ChannelSink & { taken(): readonly Frame[] } {
  const held: Frame[] = []
  let open = true
  return {
    binding: 'turn',
    get open() {
      return open
    },
    send(frames) {
      held.push(...frames)
    },
    close() {
      open = false
    },
    taken() {
      return held
    },
  }
}

/** What the channel routes need: the hub, and how a connection is identified. */
export interface ChannelRouteOptions {
  hub: ChannelHub
  /** Mount point. `?c=<id>` names the channel on every binding. */
  path?: string
  /** Called when a channel's socket drops, so a caller can release its holds. */
  onClose?(id: string, binding: ChannelBinding): void
}

const CHANNEL_QUERY = 'c'

function requestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
}

function channelId(url: URL): string | null {
  return url.searchParams.get(CHANNEL_QUERY)
}

/**
 * The bindings as a pair of handlers rather than a server, so an application can mount them
 * beside its own routes. `mountChannel` is this plus a `createServer` call.
 */
export interface ChannelHandlers {
  /** True when the request was a channel request and has been answered. */
  http(req: IncomingMessage, res: ServerResponse): boolean
  /** True when the upgrade was a channel upgrade and has been taken. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean
}

/** The endpoints a channel needs over Node's HTTP server: upgrade, stream, post-up, and turn. */
export function channelHandlers(options: ChannelRouteOptions): ChannelHandlers {
  const path = options.path ?? '/channel'
  return {
    http(req, res) {
      const url = requestUrl(req)
      if (url.pathname !== path && url.pathname !== `${path}/sse` && url.pathname !== `${path}/turn`)
        return false
      void handle(req, res, path, options)
      return true
    },
    upgrade(req, socket, head) {
      if (requestUrl(req).pathname !== path) return false
      void upgrade(req, socket, head, path, options)
      return true
    },
  }
}

/** Mounts every binding on one path: the same hub, slot source and store, with only the bytes' path varying. */
export async function mountChannel(options: ChannelRouteOptions): Promise<{
  url: string
  channelUrl(id: string, binding?: ChannelBinding): string
  close(): Promise<void>
}> {
  const path = options.path ?? '/channel'
  const handlers = channelHandlers(options)
  const server: Server = createServer((req, res) => {
    if (!handlers.http(req, res)) res.writeHead(404).end()
  })
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!handlers.upgrade(req, socket, head)) socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address === 'string' || address === null)
    throw new Error(
      'E_NO_ADDRESS: the server reported no TCP address after listening, so nothing can be told where to connect',
    )
  const origin = `http://127.0.0.1:${address.port}`
  return {
    url: `${origin}${path}`,
    channelUrl(id, binding = 'stream') {
      const scheme = binding === 'socket' ? 'ws' : 'http'
      const suffix = binding === 'sse' ? '/sse' : binding === 'turn' ? '/turn' : ''
      return `${scheme}://127.0.0.1:${address.port}${path}${suffix}?${CHANNEL_QUERY}=${encodeURIComponent(id)}`
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  options: ChannelRouteOptions,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
  const route =
    url.pathname === path
      ? 'frames'
      : url.pathname === `${path}/sse`
        ? 'sse'
        : url.pathname === `${path}/turn`
          ? 'turn'
          : null
  const id = channelId(url)
  if (!route || !id) {
    res.writeHead(404).end()
    return
  }

  if (route === 'turn') {
    await turn(req, res, id, options)
    return
  }

  if (req.method === 'GET') {
    const sink = route === 'sse' ? sseSink(res) : streamSink(res)
    options.hub.open(sink, id)
    res.on('close', () => {
      options.hub.close(id, 'downstream closed')
      options.onClose?.(id, sink.binding)
    })
    return
  }

  if (req.method !== 'POST') {
    res.writeHead(405).end()
    return
  }

  const body = await readBody(req)
  let frames: AnyFrame[]
  try {
    const text = (req.headers['content-type'] ?? '').includes('text/')
    const decoder = text ? createTextDecoder({ expect: 'up' }) : createBinaryDecoder({ expect: 'up' })
    frames = decoder.push(body)
    decoder.end()
  } catch (error) {
    res.writeHead(400, { 'content-type': 'text/plain' }).end(message(error))
    return
  }

  try {
    const sent = await options.hub.receive(id, frames)
    // 202, not 200: the answer went down the other connection.
    res.writeHead(202, { 'content-type': 'text/plain' }).end(String(sent.length))
  } catch (error) {
    res.writeHead(409, { 'content-type': 'text/plain' }).end(message(error))
  }
}

/**
 * One turn: frames up in the request body, frames down in its own response. The channel is
 * opened and closed inside this function — a record that outlived it would be a leak per turn.
 * 200, not the 202 the other half-duplex bindings answer with: this response *is* the answer. See
 * `spec/kernel/transport.md`.
 */
async function turn(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  options: ChannelRouteOptions,
): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405).end()
    return
  }

  const body = await readBody(req)
  let frames: AnyFrame[]
  try {
    const text = (req.headers['content-type'] ?? '').includes('text/')
    const decoder = text ? createTextDecoder({ expect: 'up' }) : createBinaryDecoder({ expect: 'up' })
    frames = decoder.push(body)
    decoder.end()
  } catch (error) {
    res.writeHead(400, { 'content-type': 'text/plain' }).end(message(error))
    return
  }

  const sink = turnSink()
  options.hub.open(sink, id)
  try {
    await options.hub.receive(id, frames)
    // Taken before the close: closing tells the hub this channel is gone.
    const answer = encodeStream([...sink.taken()])
    res
      .writeHead(200, {
        'content-type': 'application/warp',
        'cache-control': 'no-store',
      })
      .end(Buffer.from(answer))
  } catch (error) {
    res.writeHead(409, { 'content-type': 'text/plain' }).end(message(error))
  } finally {
    options.hub.close(id, 'turn complete')
    options.onClose?.(id, 'turn')
  }
}

async function upgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  path: string,
  options: ChannelRouteOptions,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
  const id = channelId(url)
  if (url.pathname !== path || !id) {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
    return
  }
  const connection = acceptWebSocket(req, socket, head)
  if (!connection) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    return
  }

  options.hub.open(socketSink(connection), id)
  const decoder = createBinaryDecoder({ expect: 'up' })
  connection.onMessage(async (bytes) => {
    try {
      await options.hub.receive(id, decoder.push(bytes))
    } catch (error) {
      // A protocol error from one client closes that client's channel and nothing else.
      connection.close(1002, message(error))
    }
  })
  connection.onClose(() => {
    options.hub.close(id, 'socket closed')
    options.onClose?.(id, 'socket')
  })
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function readBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return new Uint8Array(Buffer.concat(chunks))
}

/**
 * The upstream body: a preamble and the frames — a discrete POST is its own stream. Returned over
 * a real ArrayBuffer: `fetch` and `WebSocket.send` both want the narrow type Node's typings widen.
 */
export function upFrames(frames: readonly Frame[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encodeStream(frames as Frame[]))
}
