export type Direction = 'up' | 'down'

/**
 * Codes below 0x10 travel client to server, codes from 0x10 up travel server to
 * client, so a decoder can reject a frame arriving from the wrong side without
 * knowing what the frame means.
 */
export const FRAMES = {
  RESIDENT: { code: 0x01, dir: 'up' },
  HELD: { code: 0x02, dir: 'up' },
  REFRESH: { code: 0x03, dir: 'up' },
  /**
   * "Stage data for a route, do not paint", which is what the design's frame table always said it
   * was for. It asks the same question at three grains and none of the answers paint: `tpl` names
   * template versions the client does not hold, `at` names a route the client may be about to go
   * to, and `plan` names a subtree it knows nothing about at all.
   */
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
  /**
   * The answer to a route staged with `WARM at=`: what that route is, and whether this client can
   * be given it as regions at all.
   *
   * `form=slots` means the target shares this page's shell, so its regions are the frames that
   * follow — deltas where the client holds the template and the base, markup where it does not.
   * `form=document` means it does not, and the client is told to fetch the document instead: a
   * different shell is a different set of holes, and swapping regions into the wrong ones would
   * leave a page assembled out of two layouts. Only the server can decide that, because only the
   * server knows both shells.
   */
  NAV: { code: 0x1d, dir: 'down' },
  /**
   * Lazy plan extension: the part of the plan a client does not have.
   *
   * The answer to `WARM plan=<prefix>`, and the one frame here that also arrives *unasked* — once,
   * when a channel opens, carrying the route this connection is on and where its readers go next.
   * That is deliberate rather than convenient: a client has no route table to notice a gap in, and
   * what is worth telling it is a measurement only the server has.
   *
   * The body is a JSON list of routes, because it is a list of records and a header set is not one.
   * Per route: the pattern, the shell version, whether that shell is this page's, the region names,
   * the stylesheet, the template versions the regions need, and the routes readers go to next. Every
   * field is something a client would otherwise have to make a request to learn.
   */
  PLAN: { code: 0x1e, dir: 'down' },
  ERROR: { code: 0x1f, dir: 'down' },

  /**
   * Layer three of the envelope design: what a sealed response can still carry in-band.
   * Neither is a substitute for the real thing. A REDIRECT frame is acted on by the client
   * and degrades to a meta refresh with no JavaScript, but a crawler will not follow it and
   * it is not a status code. A COOKIE frame can only carry non-HttpOnly values, because
   * HttpOnly is exactly the property a body cannot grant.
   */
  REDIRECT: { code: 0x20, dir: 'down' },
  COOKIE: { code: 0x21, dir: 'down' },

  /**
   * The result of an intent, and it travels *down*. It sat at 0x06 in the up range until the
   * first real intent went over a socket, at which point the decoder rejected the server's own
   * answer as a wrong-direction frame — the direction had been decided by where the name sat in
   * the table, next to INTENT, rather than by which way the bytes go.
   *
   * The design pairs INTENT with ACK, so the name stays and the code moves. A client-to-server
   * acknowledgement had no stated meaning and nothing had ever emitted 0x06, so no reader can
   * be holding one. 0x06 is retired rather than reused: see `RETIRED`.
   */
  ACK: { code: 0x22, dir: 'down' },

  /**
   * A region announcing itself, and the only frame a composed region is allowed to open with.
   *
   * A shell composing regions from other deployments has the problem every micro-frontend
   * orchestrator has: the frames arriving from the other end are somebody else's, and nothing in a
   * length prefix says whose. `WARP` cannot answer it — that frame is the composite's negotiation
   * with its client, and a region sending one would be negotiating on the shell's behalf. So a
   * region says who it is instead: the name the shell asked for, the contract it believes it
   * serves, and the revision serving it.
   *
   * The name is what makes the splice checkable. A region may write into its own hole and nowhere
   * else, and a frame naming a sibling's slot is refused rather than forwarded — which is the
   * security half of "passing component names over the wire", and the reason this is a frame the
   * protocol has rather than a header a gateway remembers to check.
   */
  REGION: { code: 0x23, dir: 'down' },
} as const satisfies Record<string, { code: number; dir: Direction }>

/**
 * Codes that meant something once and are not to be reused. A code reused for a second purpose
 * is the one version mistake a length prefix cannot protect a reader from, because the frame
 * parses and means something else.
 */
export const RETIRED: readonly { code: number; was: string; until: string }[] = [
  { code: 0x06, was: 'ACK, in the up direction', until: 'warp 1.2.0' },
]

/**
 * A HELD frame's headers are slot names, so anything the frame has to say about itself needs a
 * key no slot can have. `$` is that key: a layout hole is named by an attribute the compiler
 * reads as an identifier, and an identifier does not start with one.
 *
 * `$only` means the frame carries the whole of what the client holds — see the HELD entry in
 * `spec/warp/warp-1.md`.
 */
export const HELD_ONLY = '$only'

/** True for a header key the frame reserved for itself rather than for a slot. */
export function reservedHeader(key: string): boolean {
  return key.startsWith('$')
}

export type FrameKind = keyof typeof FRAMES

export type HeaderValue = string | number | boolean

export type Header = Record<string, HeaderValue>

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

export type AnyFrame = Frame | UnknownFrame

const BY_CODE = new Map<number, FrameKind>()
for (const [kind, def] of Object.entries(FRAMES)) BY_CODE.set(def.code, kind as FrameKind)

export function kindForCode(code: number): FrameKind | undefined {
  return BY_CODE.get(code)
}

export function codeForKind(kind: FrameKind): number {
  return FRAMES[kind].code
}

export function directionOf(kind: FrameKind): Direction {
  return FRAMES[kind].dir
}

export function directionOfCode(code: number): Direction {
  return code < 0x10 ? 'up' : 'down'
}

export function isUnknown(value: AnyFrame): value is UnknownFrame {
  return value.kind === 'UNKNOWN'
}

export function frame(kind: FrameKind, header: Header = {}, body?: Uint8Array, bodyIsText = false): Frame {
  return { kind, header, ...(body ? { body, bodyIsText } : {}) }
}

export function str(f: AnyFrame, key: string): string | undefined {
  const v = f.header[key]
  return v === undefined ? undefined : String(v)
}

export function num(f: AnyFrame, key: string): number | undefined {
  const v = f.header[key]
  if (v === undefined) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

export function bool(f: AnyFrame, key: string): boolean | undefined {
  const v = f.header[key]
  if (v === undefined) return undefined
  return v === true || v === 'true' || v === '1'
}

export function list(f: AnyFrame, key: string): string[] {
  const v = str(f, key)
  return v ? v.split(',').filter(Boolean) : []
}
