/** Which way a frame kind travels. Declared per kind, so a frame sent the wrong way is refused. */
export type Direction = 'up' | 'down'

/** Codes below 0x10 travel client to server, codes from 0x10 up travel server to client. See `spec/warp/warp-1.md`. */
export const FRAMES = {
  RESIDENT: { code: 0x01, dir: 'up' },
  HELD: { code: 0x02, dir: 'up' },
  REFRESH: { code: 0x03, dir: 'up' },
  /** Stage data for a route, do not paint — at three grains: `tpl`, `at`, `plan`. See `spec/warp/warp-1.md`. */
  WARM: { code: 0x04, dir: 'up' },
  INTENT: { code: 0x05, dir: 'up' },
  RESUME: { code: 0x07, dir: 'up' },

  WARP: { code: 0x10, dir: 'down' },
  SHELL: { code: 0x11, dir: 'down' },
  SLOT: { code: 0x12, dir: 'down' },
  HTML: { code: 0x13, dir: 'down' },
  TPL: { code: 0x14, dir: 'down' },
  DATA: { code: 0x15, dir: 'down' },
  DELTA: { code: 0x16, dir: 'down' },
  PATCH: { code: 0x17, dir: 'down' },
  SIGNAL: { code: 0x18, dir: 'down' },
  COMMIT: { code: 0x19, dir: 'down' },
  MOD: { code: 0x1a, dir: 'down' },
  CSS: { code: 0x1b, dir: 'down' },
  STALE: { code: 0x1c, dir: 'down' },
  /** The answer to `WARM at=`: what the route is, and `form` says whether it can be given as regions. See `spec/warp/warp-1.md`. */
  NAV: { code: 0x1d, dir: 'down' },
  /** Lazy plan extension. The answer to `WARM plan=<prefix>`, and the one frame that also arrives unasked. See `spec/warp/warp-1.md`. */
  PLAN: { code: 0x1e, dir: 'down' },
  ERROR: { code: 0x1f, dir: 'down' },

  /** Layer three of the envelope design: what a sealed response can still carry in-band. See `spec/warp/warp-1.md`. */
  REDIRECT: { code: 0x20, dir: 'down' },
  COOKIE: { code: 0x21, dir: 'down' },

  /** The result of an intent. Moved here from a retired 0x06 up-slot — see `RETIRED` and `spec/warp/warp-1.md`. */
  ACK: { code: 0x22, dir: 'down' },

  /** A region announcing itself: the only frame a composed region may open with. See `spec/warp/warp-1.md`. */
  REGION: { code: 0x23, dir: 'down' },
} as const satisfies Record<string, { code: number; dir: Direction }>

/** Codes that meant something once and are not to be reused — the one version mistake a length prefix can't catch. */
export const RETIRED: readonly { code: number; was: string; until: string }[] = [
  { code: 0x06, was: 'ACK, in the up direction', until: 'warp 1.2.0' },
]

/** `$` is reserved because a HELD frame's headers are slot names. `$only` means the whole of what the client holds. See `spec/warp/warp-1.md`. */
export const HELD_ONLY = '$only'

/** True for a header key the frame reserved for itself rather than for a slot. */
export function reservedHeader(key: string): boolean {
  return key.startsWith('$')
}

/** Every frame this version defines. An unknown code is carried rather than refused. */
export type FrameKind = keyof typeof FRAMES

/** What a header value can be. Everything is text on the wire; these are what it parses back to. */
export type HeaderValue = string | number | boolean

/** A frame's header: names, never content. Whatever is large belongs in the body. */
export type Header = Record<string, HeaderValue>

/** One frame: a kind, a header of names, and an optional body. */
export interface Frame {
  kind: FrameKind
  header: Header
  body?: Uint8Array
  /** Set when the body is UTF-8 text rather than opaque bytes. */
  bodyIsText?: boolean
}

/** A frame kind this build does not know. Skippable, which is the whole point of length prefixes. */
export interface UnknownFrame {
  kind: 'UNKNOWN'
  code: number
  header: Header
  body?: Uint8Array
  bodyIsText?: boolean
}

/** A frame this version understands, or one it does not. Both are carried; only one is read. */
export type AnyFrame = Frame | UnknownFrame

const BY_CODE = new Map<number, FrameKind>()
for (const [kind, def] of Object.entries(FRAMES)) BY_CODE.set(def.code, kind as FrameKind)

/** The kind a code names, or nothing — in which case the frame is carried as unknown. */
export function kindForCode(code: number): FrameKind | undefined {
  return BY_CODE.get(code)
}

/** The binary code for a kind. Retired codes are never reused — see `spec/VERSIONING.md`. */
export function codeForKind(kind: FrameKind): number {
  return FRAMES[kind].code
}

/** Which way this kind travels. */
export function directionOf(kind: FrameKind): Direction {
  return FRAMES[kind].dir
}

/** Which way a code travels, without needing to know the kind it names. */
export function directionOfCode(code: number): Direction {
  return code < 0x10 ? 'up' : 'down'
}

/**
 * Whether this frame is one this version does not define.
 *
 * An unknown frame is skipped intact rather than dropped, which is what makes a minor additive: an
 * older reader passes a newer frame along instead of ending the stream over it.
 */
export function isUnknown(value: AnyFrame): value is UnknownFrame {
  return value.kind === 'UNKNOWN'
}

/** A frame, with the direction check the kind implies already done. */
export function frame(kind: FrameKind, header: Header = {}, body?: Uint8Array, bodyIsText = false): Frame {
  return { kind, header, ...(body ? { body, bodyIsText } : {}) }
}

/** A header read as text. */
export function str(f: AnyFrame, key: string): string | undefined {
  const v = f.header[key]
  return v === undefined ? undefined : String(v)
}

/** A header read as a number. Absent and unparseable are both undefined. */
export function num(f: AnyFrame, key: string): number | undefined {
  const v = f.header[key]
  if (v === undefined) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/** A header read as a boolean. Absent and malformed are both undefined: a header is text. */
export function bool(f: AnyFrame, key: string): boolean | undefined {
  const v = f.header[key]
  if (v === undefined) return undefined
  return v === true || v === 'true' || v === '1'
}

/** A comma-separated header as a list. Empty when absent, so a caller needs no guard. */
export function list(f: AnyFrame, key: string): string[] {
  const v = str(f, key)
  return v ? v.split(',').filter(Boolean) : []
}
