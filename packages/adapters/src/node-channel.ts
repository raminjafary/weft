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
} from '../../warp/src/index.ts'
import type { ChannelBinding, ChannelHub, ChannelSink } from '../../kernel/src/channel.ts'
import { acceptWebSocket, type WebSocketConnection } from './node-websocket.ts'

/**
 * The three bindings the design names, over a real socket.
 *
 * They differ in exactly two things — how a frame becomes bytes, and whether the same
 * connection can carry frames back — and nothing else. So each is a `ChannelSink` and the
 * state machine above them does not know which one it is talking to.
 *
 * | Binding  | Down                        | Up               | Framing |
 * | -------- | --------------------------- | ---------------- | ------- |
 * | `stream` | one long-lived GET response | discrete POSTs   | binary  |
 * | `sse`    | `text/event-stream`         | discrete POSTs   | text    |
 * | `socket` | WebSocket                   | the same socket  | binary  |
 *
 * The two costs worth stating rather than discovering. SSE cannot carry binary at all, so it
 * uses the text framing and pays base64 on every non-text body — which is why it is not the
 * default. And the two half-duplex bindings answer an upstream POST down the *other*
 * connection, so a POST arriving after the downstream has dropped is `E_NO_DOWNSTREAM`: the
 * frames were understood and there was nowhere to put the answer.
 */
export function streamSink(res: ServerResponse): ChannelSink {
  let open = true
  res.writeHead(200, {
    'content-type': 'application/warp',
    'cache-control': 'no-store',
    // Otherwise a reverse proxy buffers the whole thing and the channel is a slow poll.
    'x-accel-buffering': 'no',
  })
  res.flushHeaders()
  res.write(preamble())
  res.on('close', () => {
    open = false
  })
  return {
    binding: 'stream',
    get open() {
      return open && !res.writableEnded
    },
    send(frames) {
      if (!open) return
      // No preamble per frame: it went out with the headers, and this is one stream for the
      // channel's whole life.
      for (const f of frames) res.write(encodeBinaryFrame(f))
    },
    close() {
      if (!open) return
      open = false
      res.end()
    },
  }
}

export function sseSink(res: ServerResponse): ChannelSink {
  let open = true
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
  return {
    binding: 'sse',
    get open() {
      return open && !res.writableEnded
    },
    send(frames) {
      if (!open) return
      // One frame per event. The text framing already guarantees no interior newline, which
      // is what makes an SSE `data:` line able to carry a frame at all.
      for (const f of frames) res.write(`data: ${encodeTextFrame(f)}\n\n`)
    },
    close() {
      if (!open) return
      open = false
      res.end()
    },
  }
}

export function socketSink(connection: WebSocketConnection): ChannelSink {
  // One preamble per connection, as its own message: a WebSocket delivers whole messages, so
  // the decoder on the other side sees exactly the stream the other two bindings produce.
  connection.send(preamble())
  return {
    binding: 'socket',
    get open() {
      return connection.open
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

export interface ChannelRouteOptions {
  hub: ChannelHub
  /** Mount point. `?c=<id>` names the channel on every binding. */
  path?: string
  /** Called when a channel's socket drops, so a caller can release its holds. */
  onClose?(id: string, binding: ChannelBinding): void
}

const CHANNEL_QUERY = 'c'

function channelId(url: URL): string | null {
  return url.searchParams.get(CHANNEL_QUERY)
}

/**
 * Mounts all three bindings on one path, which is the arrangement that makes the honest
 * comparison possible: the same hub, the same slot source, the same store, and the only
 * variable is how the bytes moved.
 */
export async function mountChannel(options: ChannelRouteOptions): Promise<{
  url: string
  channelUrl(id: string, binding?: ChannelBinding): string
  close(): Promise<void>
}> {
  const path = options.path ?? '/channel'
  const server: Server = createServer((req, res) => {
    void handle(req, res, path, options)
  })
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void upgrade(req, socket, head, path, options)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address === 'string' || address === null) throw new Error('E_NO_ADDRESS')
  const origin = `http://127.0.0.1:${address.port}`
  return {
    url: `${origin}${path}`,
    channelUrl(id, binding = 'stream') {
      const scheme = binding === 'socket' ? 'ws' : 'http'
      const suffix = binding === 'sse' ? '/sse' : ''
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
  const route = url.pathname === path ? 'frames' : url.pathname === `${path}/sse` ? 'sse' : null
  const id = channelId(url)
  if (!route || !id) {
    res.writeHead(404).end()
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
    // 202, not 200: the answer went down the other connection, and saying 200 here would
    // suggest this response carried it.
    res.writeHead(202, { 'content-type': 'text/plain' }).end(String(sent.length))
  } catch (error) {
    res.writeHead(409, { 'content-type': 'text/plain' }).end(message(error))
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
 * The upstream body: a preamble and the frames, because a discrete POST is its own stream and
 * has no earlier one to have announced a version in. Eight bytes per POST, which is the price
 * of the half-duplex bindings and is why the socket binding announces itself once.
 *
 * Returned as a Uint8Array over a real ArrayBuffer: Node's typings widen the buffer of most
 * byte arrays to ArrayBufferLike, and `fetch` and `WebSocket.send` both want the narrow one.
 */
export function upFrames(frames: readonly Frame[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encodeStream(frames as Frame[]))
}
