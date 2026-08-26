import {
  FRAMES,
  type AnyFrame,
  type Frame,
  type FrameKind,
  type Header,
  type HeaderValue,
  codeForKind,
  directionOf,
  directionOfCode,
  kindForCode,
} from './frames.ts'
import { PREAMBLE_BYTES, WARP_MAGIC, WARP_MAJOR, WARP_MINOR } from './version.ts'

const utf8 = new TextEncoder()
const decodeUtf8 = new TextDecoder()

const NEEDS_ENCODING = /[ =%\n\r]/

function encodeValue(v: HeaderValue): string {
  const s = String(v)
  return NEEDS_ENCODING.test(s) ? encodeURIComponent(s) : s
}

function decodeValue(s: string): string {
  return s.includes('%') ? decodeURIComponent(s) : s
}

/** A header as one line. Keys are sorted, so the same header is always the same bytes. */
export function encodeHeader(header: Header): string {
  return Object.entries(header)
    .map(([k, v]) => `${k}=${encodeValue(v)}`)
    .join(' ')
}

/** A header line as names and values, with numbers and booleans parsed back. */
export function decodeHeader(text: string): Header {
  const header: Header = {}
  if (!text) return header
  for (const token of text.split(' ')) {
    if (!token) continue
    const eq = token.indexOf('=')
    if (eq < 0) {
      header[token] = true
      continue
    }
    header[token.slice(0, eq)] = decodeValue(token.slice(eq + 1))
  }
  return header
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(s)
}

function fromBase64(b64: string): Uint8Array {
  const raw = atob(b64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

/**
 * Text framing: one frame per line, for dev tooling and traces. Bodies are encoded
 * into the line, so text framing is not byte-transparent and production uses binary.
 */
export function encodeTextFrame(f: Frame): string {
  const parts: string[] = [f.kind]
  const header = encodeHeader(f.header)
  if (header) parts.push(header)
  if (f.body) {
    parts.push(
      f.bodyIsText ? `body=${encodeURIComponent(decodeUtf8.decode(f.body))}` : `bodyB64=${toBase64(f.body)}`,
    )
  }
  return parts.join(' ')
}

/** One line as a frame. An unknown kind comes back as an unknown frame rather than an error. */
export function decodeTextFrame(line: string): AnyFrame {
  const trimmed = line.trim()
  if (!trimmed) throw new Error('E_EMPTY_FRAME: a frame needs a kind and a header')
  const space = trimmed.indexOf(' ')
  const kindText = space < 0 ? trimmed : trimmed.slice(0, space)
  const header = decodeHeader(space < 0 ? '' : trimmed.slice(space + 1))

  let body: Uint8Array | undefined
  let bodyIsText = false
  if (typeof header.body === 'string') {
    body = utf8.encode(decodeURIComponent(header.body))
    bodyIsText = true
    delete header.body
  } else if (typeof header.bodyB64 === 'string') {
    body = fromBase64(header.bodyB64)
    delete header.bodyB64
  }

  const kind = kindText in FRAMES ? (kindText as FrameKind) : undefined
  if (!kind) {
    return {
      kind: 'UNKNOWN',
      code: -1,
      header: { ...header, name: kindText },
      ...(body ? { body, bodyIsText } : {}),
    }
  }
  return { kind, header, ...(body ? { body, bodyIsText } : {}) }
}

export function preamble(major = WARP_MAJOR, minor = WARP_MINOR): Uint8Array {
  const out = new Uint8Array(PREAMBLE_BYTES)
  out.set(utf8.encode(WARP_MAGIC), 0)
  out[4] = major
  out[5] = minor
  return out
}

/** One frame as length-prefixed bytes: code, header length, body length, then the two. */
export function encodeBinaryFrame(f: Frame): Uint8Array {
  const headerBytes = utf8.encode(encodeHeader(f.header))
  const bodyBytes = f.body ?? new Uint8Array(0)
  if (headerBytes.length > 0xffff) {
    throw new Error(`E_HEADER_TOO_LARGE: ${headerBytes.length} B against a 16-bit field; use the body`)
  }
  const out = new Uint8Array(8 + headerBytes.length + bodyBytes.length)
  const view = new DataView(out.buffer)
  out[0] = codeForKind(f.kind)
  out[1] = (f.body ? 1 : 0) | (f.bodyIsText ? 2 : 0)
  view.setUint16(2, headerBytes.length, true)
  view.setUint32(4, bodyBytes.length, true)
  out.set(headerBytes, 8)
  out.set(bodyBytes, 8 + headerBytes.length)
  return out
}

/** What a decoder refuses, as opposed to what it cannot read. */
export interface DecoderOptions {
  /** Reject frames travelling the wrong way, which is a protocol violation, not a version gap. */
  expect?: 'up' | 'down'
  /** Refuse a stream whose preamble announces a different major. */
  major?: number
}

/** A streaming decoder: push bytes, take whole frames, and read back what the peer announced. */
export interface Decoder {
  push(chunk: Uint8Array): AnyFrame[]
  end(): void
  peer: { major: number; minor: number } | null
}

/** The length-prefixed binary decoder. What a socket uses. */
export function createBinaryDecoder(options: DecoderOptions = {}): Decoder {
  let buf: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
  let sawPreamble = false
  const state: Decoder = {
    peer: null,
    push(chunk) {
      buf = concatBytes(buf, chunk)
      const frames: AnyFrame[] = []

      if (!sawPreamble) {
        if (buf.length < PREAMBLE_BYTES) return frames
        const magic = decodeUtf8.decode(buf.subarray(0, 4))
        // Terse: this module is reachable from the document request path, which has a byte budget.
        if (magic !== WARP_MAGIC) throw new Error(`E_BAD_MAGIC: ${magic} is not ${WARP_MAGIC}`)
        const major = buf[4] as number
        const minor = buf[5] as number
        const want = options.major ?? WARP_MAJOR
        if (major !== want) {
          throw new Error(`E_WARP_MAJOR: peer speaks warp ${major}.x, this build speaks ${want}.x`)
        }
        state.peer = { major, minor }
        sawPreamble = true
        buf = buf.subarray(PREAMBLE_BYTES)
      }

      for (;;) {
        if (buf.length < 8) break
        const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
        const code = buf[0] as number
        const flags = buf[1] as number
        const headerLen = view.getUint16(2, true)
        const bodyLen = view.getUint32(4, true)
        const total = 8 + headerLen + bodyLen
        if (buf.length < total) break

        const header = decodeHeader(decodeUtf8.decode(buf.subarray(8, 8 + headerLen)))
        const hasBody = (flags & 1) === 1
        const bodyIsText = (flags & 2) === 2
        const body = hasBody ? buf.slice(8 + headerLen, total) : undefined

        if (options.expect && directionOfCode(code) !== options.expect) {
          throw new Error(
            `E_WRONG_DIRECTION: frame code 0x${code.toString(16)} is not a ${options.expect} frame`,
          )
        }

        const kind = kindForCode(code)
        if (!kind) {
          frames.push({ kind: 'UNKNOWN', code, header, ...(body ? { body, bodyIsText } : {}) })
        } else {
          if (options.expect && directionOf(kind) !== options.expect) {
            throw new Error(`E_WRONG_DIRECTION: ${kind} is a ${directionOf(kind)} frame`)
          }
          frames.push({ kind, header, ...(body ? { body, bodyIsText } : {}) })
        }
        buf = buf.subarray(total)
      }
      return frames
    },
    end() {
      if (buf.length > 0) throw new Error(`E_TRUNCATED_FRAME: ${buf.length} trailing bytes`)
    },
  }
  return state
}

/** The newline-delimited text decoder. What an event stream uses, where a frame is a line. */
export function createTextDecoder(options: DecoderOptions = {}): Decoder {
  let pending = ''
  const state: Decoder = {
    peer: null,
    push(chunk) {
      pending += decodeUtf8.decode(chunk, { stream: true })
      const frames: AnyFrame[] = []
      let nl: number
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl)
        pending = pending.slice(nl + 1)
        if (!line.trim()) continue
        const f = decodeTextFrame(line)
        if (options.expect && f.kind !== 'UNKNOWN' && directionOf(f.kind) !== options.expect) {
          throw new Error(`E_WRONG_DIRECTION: ${f.kind} is a ${directionOf(f.kind)} frame`)
        }
        frames.push(f)
      }
      return frames
    },
    end() {
      if (pending.trim()) throw new Error('E_TRUNCATED_FRAME: unterminated line')
    },
  }
  return state
}

/** A whole stream, preamble included. What a test and a server both send. */
export function encodeStream(frames: Frame[], mode: 'binary' | 'text' = 'binary'): Uint8Array {
  if (mode === 'text') return utf8.encode(frames.map(encodeTextFrame).join('\n') + '\n')
  const parts = [preamble(), ...frames.map(encodeBinaryFrame)]
  return parts.reduce<Uint8Array>((acc, p) => concatBytes(acc, p), new Uint8Array(0))
}

/** Two buffers as one. A decoder holds a partial frame across chunks and this is how it grows. */
export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b
  if (b.length === 0) return a
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}
