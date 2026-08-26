import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

/**
 * RFC 6455, server side, and only the part a Warp channel uses: the upgrade handshake,
 * binary and text data frames with continuation, ping/pong, and a close handshake. No
 * extensions and no `permessage-deflate` — Warp frames are already length-prefixed and
 * bodies are compressed by the layer that produced them, so negotiating a second
 * compression would be paying twice for one property.
 *
 * Written rather than depended on because the alternative is a runtime dependency in an
 * adapter whose entire job is to be small and replaceable, and because Node has a WebSocket
 * *client* built in but no server. The client half being built in is what makes the test
 * honest: a real browser-grade client over a real socket.
 */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

const OP = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const

export interface WebSocketConnection {
  readonly open: boolean
  /** True when the socket buffer is above its watermark: the peer is not reading. */
  readonly saturated: boolean
  send(bytes: Uint8Array): void
  sendText(text: string): void
  onMessage(handler: (bytes: Uint8Array, isText: boolean) => void | Promise<void>): void
  onClose(handler: (code: number, reason: string) => void): void
  close(code?: number, reason?: string): void
}

export function acceptWebSocket(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): WebSocketConnection | null {
  const key = req.headers['sec-websocket-key']
  if (typeof key !== 'string' || (req.headers.upgrade ?? '').toLowerCase() !== 'websocket') return null

  const accept = createHash('sha1')
    .update(key + GUID)
    .digest('base64')
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'),
  )
  // Nagle would coalesce small frames and turn an interactive channel into a batched one.
  ;(socket as Duplex & { setNoDelay?(on: boolean): void }).setNoDelay?.(true)

  let open = true
  let saturated = false
  let buffer: Buffer = head.length ? Buffer.from(head) : Buffer.alloc(0)
  let fragments: Buffer[] = []
  let fragmentOpcode: number | null = null
  const messageHandlers: ((bytes: Uint8Array, isText: boolean) => void | Promise<void>)[] = []
  const closeHandlers: ((code: number, reason: string) => void)[] = []

  const finish = (code: number, reason: string): void => {
    if (!open) return
    open = false
    for (const handler of closeHandlers) handler(code, reason)
  }

  const connection: WebSocketConnection = {
    get open() {
      return open && !socket.destroyed
    },
    get saturated() {
      return saturated
    },
    send(bytes) {
      if (!open) return
      if (!socket.write(encodeFrame(OP.binary, Buffer.from(bytes)))) saturated = true
    },
    sendText(text) {
      if (!open) return
      if (!socket.write(encodeFrame(OP.text, Buffer.from(text, 'utf8')))) saturated = true
    },
    onMessage(handler) {
      messageHandlers.push(handler)
    },
    onClose(handler) {
      closeHandlers.push(handler)
    },
    close(code = 1000, reason = '') {
      if (!open) return
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason))
      payload.writeUInt16BE(code, 0)
      payload.write(reason, 2, 'utf8')
      socket.write(encodeFrame(OP.close, payload))
      open = false
      socket.end()
      for (const handler of closeHandlers) handler(code, reason)
    },
  }

  socket.on('data', (chunk: Buffer) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
    for (;;) {
      const parsed = readFrame(buffer)
      if (!parsed) break
      buffer = buffer.subarray(parsed.consumed)
      const { fin, opcode, payload } = parsed

      if (opcode === OP.close) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : ''
        if (open) {
          socket.write(encodeFrame(OP.close, payload.subarray(0, 2)))
          socket.end()
        }
        finish(code, reason)
        return
      }
      if (opcode === OP.ping) {
        socket.write(encodeFrame(OP.pong, payload))
        continue
      }
      if (opcode === OP.pong) continue

      if (opcode === OP.continuation) {
        if (fragmentOpcode === null) {
          connection.close(1002, 'continuation with nothing to continue')
          return
        }
        fragments.push(payload)
      } else {
        if (fragmentOpcode !== null) {
          connection.close(1002, 'a new data frame arrived mid-fragment')
          return
        }
        if (!fin) {
          fragmentOpcode = opcode
          fragments = [payload]
          continue
        }
        void deliver(opcode, payload)
        continue
      }

      if (fin) {
        const whole = Buffer.concat(fragments)
        const opcodeWas = fragmentOpcode
        fragments = []
        fragmentOpcode = null
        void deliver(opcodeWas as number, whole)
      }
    }
  })

  socket.on('drain', () => {
    saturated = false
  })
  socket.on('close', () => finish(1006, 'socket closed'))
  socket.on('error', () => finish(1006, 'socket error'))

  async function deliver(opcode: number, payload: Buffer): Promise<void> {
    const isText = opcode === OP.text
    for (const handler of messageHandlers) await handler(new Uint8Array(payload), isText)
  }

  return connection
}

interface ParsedFrame {
  fin: boolean
  opcode: number
  payload: Buffer
  consumed: number
}

function readFrame(buf: Buffer): ParsedFrame | null {
  if (buf.length < 2) return null
  const first = buf[0] as number
  const second = buf[1] as number
  const fin = (first & 0x80) !== 0
  const opcode = first & 0x0f
  const masked = (second & 0x80) !== 0
  let length = second & 0x7f
  let offset = 2

  if (length === 126) {
    if (buf.length < offset + 2) return null
    length = buf.readUInt16BE(offset)
    offset += 2
  } else if (length === 127) {
    if (buf.length < offset + 8) return null
    const big = buf.readBigUInt64BE(offset)
    // A 4 GB Warp frame is a bug on the other side, not a payload to allocate for.
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(
        `E_WS_FRAME_TOO_LARGE: the peer announced a ${big}-byte frame. That is a bug on the other ` +
          `side, not a payload to allocate for`,
      )
    }
    length = Number(big)
    offset += 8
  }

  const maskLength = masked ? 4 : 0
  if (buf.length < offset + maskLength + length) return null

  let payload = buf.subarray(offset + maskLength, offset + maskLength + length)
  if (masked) {
    const mask = buf.subarray(offset, offset + 4)
    const unmasked = Buffer.allocUnsafe(length)
    for (let i = 0; i < length; i++) unmasked[i] = (payload[i] as number) ^ (mask[i % 4] as number)
    payload = unmasked
  }
  return { fin, opcode, payload, consumed: offset + maskLength + length }
}

/** Server to client is never masked, which RFC 6455 requires rather than permits. */
function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length
  let header: Buffer
  if (length < 126) {
    header = Buffer.allocUnsafe(2)
    header[1] = length
  } else if (length < 0x10000) {
    header = Buffer.allocUnsafe(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.allocUnsafe(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, payload])
}
