import { frame, list, str, type Frame } from './frames.ts'
import { WARP_SPEC } from './version.ts'

/** The forms a client may accept. Mirrors the IR's own list, because the wire is the contract. */
export type WireForm = 'html' | 'bundle' | 'split' | 'patch' | 'delta' | 'remote'

/**
 * How the document itself reached the client. `buffered` is the webview case: an app
 * serving the document through WKURLSchemeHandler or Android's shouldInterceptRequest
 * supplies the bytes itself, and those paths buffer, so "the initial response is the
 * first frames" stops being true and there is no HTTP layer underneath at all.
 *
 * `turn` is the client saying it has no held downstream at all: every frame it will ever receive
 * is the answer to a request it made. Frames still arrive as a length-prefixed stream and every
 * form is still available — a turn is a bounded stream, not a degraded one — so what it changes is
 * not how bytes are read but what the server may assume it can do, which is why the negotiation
 * names it as a downgrade rather than leaving the client to discover that nothing is ever pushed.
 */
export type Transport = 'stream' | 'buffered' | 'socket' | 'turn'

/** What a client announces: its versions, the forms it accepts, and the templates it holds. */
export interface ClientHello {
  warp: string
  ir: string
  /** Coarse, bucketed digest of held template versions. Never a precise set. */
  tpl?: string
  forms?: WireForm[]
  transport?: Transport
  /** Incremental declarative-shadow-DOM parsing, not merely DSD support. */
  dsd?: boolean
  /** Same-document View Transitions, for committing an epoch without a flash. */
  vt?: boolean
  /** Service workers. Unavailable in generic WKWebView and suppressed by many in-app browsers. */
  sw?: boolean
  /** Persistent storage the resident-template set can live in when there is no service worker. */
  idb?: boolean
  rtt?: number
  ect?: string
  cpu?: number
  engine?: string
  caps?: string[]
}

/** What this server can offer, so the intersection is a fact rather than an assumption. */
export interface ServerCapabilities {
  warp: string
  ir: string
  forms: WireForm[]
}

/**
 * There is deliberately no default. This package owns the Warp version and nothing else —
 * the template IR is versioned separately, on purpose, and a default here could only ever
 * state an IR version this package cannot see.
 *
 * It did, for a while: `SERVER_DEFAULTS.ir` said `1.0.0` while the emitter had moved to
 * 2.4.0, so every current client negotiated an IR *major* mismatch and was served
 * `html` only. Whoever composes a Warp version with an IR version has to be able to see
 * both, which is the kernel — `serverCapabilities()` there.
 */
export const WARP_FORMS: WireForm[] = ['html', 'bundle', 'split', 'patch', 'delta']

/** What was settled: the versions, the forms, and the strategy both ends agreed on. */
export interface Negotiation {
  ok: boolean
  spec: string
  warp: string
  ir: string
  forms: WireForm[]
  /** How this response will be delivered, after the client's transport is taken into account. */
  strategy: 'stream' | 'collapse' | 'socket'
  /** Who fills an out-of-order hole: the parser, or the ~1 KB filler script. */
  fill: 'dsd' | 'script'
  commit: 'view-transition' | 'instant'
  /** Where a returning client may keep resident templates. */
  residency: 'service-worker' | 'indexeddb' | 'http-cache'
  /** Whether a severed channel may continue instead of restarting. Webviews get frozen often. */
  resumable: boolean
  downgrades: string[]
  fatal?: string
}

function major(v: string): number {
  return Number(v.split('.')[0] ?? NaN)
}

function minVersion(a: string, b: string): string {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x < y ? a : b
  }
  return a
}

/**
 * Capability variance is not a special case: a browser, a webview, and a stale cache
 * are the same problem, and they get the same mechanism. Nothing here fails — every
 * missing capability costs a form, a fill mechanism, or an animation, never correctness.
 */
export function negotiate(hello: ClientHello, server: ServerCapabilities): Negotiation {
  const downgrades: string[] = []

  const transport: Transport = hello.transport ?? 'stream'
  const base = {
    spec: WARP_SPEC,
    strategy: (transport === 'socket'
      ? 'socket'
      : transport === 'buffered'
        ? 'collapse'
        : 'stream') as Negotiation['strategy'],
    fill: (hello.dsd === false ? 'script' : 'dsd') as Negotiation['fill'],
    commit: (hello.vt === false ? 'instant' : 'view-transition') as Negotiation['commit'],
    residency: (hello.sw
      ? 'service-worker'
      : hello.idb
        ? 'indexeddb'
        : 'http-cache') as Negotiation['residency'],
    resumable: transport !== 'buffered',
  }

  if (major(hello.warp) !== major(server.warp)) {
    return {
      ...base,
      ok: false,
      warp: server.warp,
      ir: server.ir,
      forms: ['html'],
      strategy: 'collapse',
      resumable: false,
      downgrades: ['transport: warp unavailable, fall back to request/response'],
      fatal: `E_WARP_MAJOR: client speaks warp ${hello.warp}, server speaks ${server.warp}`,
    }
  }

  const warp = minVersion(hello.warp, server.warp)
  if (warp !== server.warp) downgrades.push(`warp ${server.warp} -> ${warp}`)

  if (transport === 'buffered') {
    downgrades.push(
      'document response is buffered by the host app, so holes cannot arrive out of order: slots collapse into the document and later frames need the socket binding',
    )
  }
  if (transport === 'turn') {
    downgrades.push(
      'no held downstream, so the server cannot speak first: an invalidation is carried on the next turn rather than pushed when it happens',
    )
  }
  if (base.fill === 'script') {
    downgrades.push('incremental DSD parsing unavailable: holes fill via the ~1 KB filler script')
  }
  if (base.commit === 'instant') {
    downgrades.push(
      'no same-document View Transitions: an epoch commit is an instant swap, not an animated one',
    )
  }
  if (base.residency === 'http-cache') {
    downgrades.push(
      'no service worker and no IndexedDB: resident templates live only in the HTTP cache, so repeat-visit gains are not guaranteed',
    )
  }

  if (major(hello.ir) !== major(server.ir)) {
    return {
      ...base,
      ok: true,
      warp,
      ir: server.ir,
      forms: ['html'],
      downgrades: [...downgrades, `ir major mismatch (client ${hello.ir}, server ${server.ir}): html only`],
    }
  }

  const ir = minVersion(hello.ir, server.ir)
  if (ir !== server.ir) downgrades.push(`ir ${server.ir} -> ${ir}`)

  const clientForms = hello.forms ?? ['html']
  let forms = server.forms.filter((f) => clientForms.includes(f))
  if (transport === 'buffered') forms = forms.filter((f) => f !== 'split')
  if (!forms.includes('html')) forms.unshift('html')
  const dropped = server.forms.filter((f) => !forms.includes(f))
  if (dropped.length) downgrades.push(`forms unavailable to this client: ${dropped.join(',')}`)

  return { ...base, ok: true, warp, ir, forms, downgrades }
}

/** A `RESIDENT` frame from a client hello. */
export function residentFrame(hello: ClientHello): Frame {
  return frame('RESIDENT', {
    warp: hello.warp,
    ir: hello.ir,
    ...(hello.tpl ? { tpl: hello.tpl } : {}),
    ...(hello.forms ? { forms: hello.forms.join(',') } : {}),
    ...(hello.transport ? { transport: hello.transport } : {}),
    ...(hello.dsd !== undefined ? { dsd: hello.dsd } : {}),
    ...(hello.vt !== undefined ? { vt: hello.vt } : {}),
    ...(hello.sw !== undefined ? { sw: hello.sw } : {}),
    ...(hello.idb !== undefined ? { idb: hello.idb } : {}),
    ...(hello.rtt !== undefined ? { rtt: hello.rtt } : {}),
    ...(hello.ect ? { ect: hello.ect } : {}),
    ...(hello.cpu !== undefined ? { cpu: hello.cpu } : {}),
    ...(hello.engine ? { engine: hello.engine } : {}),
    ...(hello.caps?.length ? { caps: hello.caps.join(',') } : {}),
  })
}

function flag(f: Frame, key: string): boolean | undefined {
  const raw = str(f, key)
  if (raw === undefined) return undefined
  return raw === 'true' || raw === '1'
}

/** A client hello back out of a `RESIDENT` frame. */
export function readResident(f: Frame): ClientHello {
  return {
    warp: str(f, 'warp') ?? '0.0.0',
    ir: str(f, 'ir') ?? '0.0.0',
    ...(str(f, 'tpl') ? { tpl: str(f, 'tpl') as string } : {}),
    forms: list(f, 'forms') as WireForm[],
    ...(str(f, 'transport') ? { transport: str(f, 'transport') as Transport } : {}),
    ...(flag(f, 'dsd') !== undefined ? { dsd: flag(f, 'dsd') as boolean } : {}),
    ...(flag(f, 'vt') !== undefined ? { vt: flag(f, 'vt') as boolean } : {}),
    ...(flag(f, 'sw') !== undefined ? { sw: flag(f, 'sw') as boolean } : {}),
    ...(flag(f, 'idb') !== undefined ? { idb: flag(f, 'idb') as boolean } : {}),
    ...(str(f, 'rtt') ? { rtt: Number(str(f, 'rtt')) } : {}),
    ...(str(f, 'ect') ? { ect: str(f, 'ect') as string } : {}),
    ...(str(f, 'cpu') ? { cpu: Number(str(f, 'cpu')) } : {}),
    ...(str(f, 'engine') ? { engine: str(f, 'engine') as string } : {}),
    caps: list(f, 'caps'),
  }
}

/** The first frame the server sends, and the only place versions and strategy are stated on the wire. */
/**
 * The frame that settles a negotiation — including, now, the case where nothing was settled.
 *
 * `ok` and `fatal` are on the `Negotiation` and were not on the frame, which meant a client whose
 * major this server cannot speak received a `WARP` frame that looked exactly like an ordinary
 * degraded one: `forms=html`, `strategy=collapse`, a downgrade line about the transport. The one
 * thing it did not say is that the stream is unusable and why.
 *
 * That was only reachable by a client that lies about its version — the binary preamble refuses a
 * different major three bytes in, before any of this — but "only reachable by a misbehaving peer"
 * is exactly the case a protocol has to answer clearly, because the peer misbehaving may be a proxy
 * or an old build rather than an attacker.
 *
 * Additive: `ok` is absent from no frame this server has ever sent (it was `true` in every one), and
 * a reader that does not know the header reads the forms it always read.
 */
export function warpFrame(n: Negotiation): Frame {
  return frame('WARP', {
    spec: n.spec,
    v: n.warp,
    ir: n.ir,
    forms: n.forms.join(','),
    strategy: n.strategy,
    fill: n.fill,
    commit: n.commit,
    residency: n.residency,
    resume: n.resumable,
    ok: n.ok,
    ...(n.fatal ? { fatal: n.fatal } : {}),
    ...(n.downgrades.length ? { downgrade: n.downgrades.join('; ') } : {}),
  })
}

/**
 * A frozen and evicted webview reconnects with the last epoch it committed and the
 * templates it still holds, and the server continues from there rather than restarting.
 */
export function resumeFrame(input: { epoch: string; tpl?: string; since?: number }): Frame {
  return frame('RESUME', {
    epoch: input.epoch,
    ...(input.tpl ? { tpl: input.tpl } : {}),
    ...(input.since !== undefined ? { since: input.since } : {}),
  })
}
