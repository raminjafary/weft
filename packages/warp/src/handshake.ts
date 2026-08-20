import { frame, list, str, type Frame } from './frames.ts'
import { WARP_SPEC, WARP_VERSION } from './version.ts'

export type WireForm = 'html' | 'bundle' | 'split' | 'patch' | 'data' | 'delta' | 'remote'

/**
 * How the document itself reached the client. `buffered` is the webview case: an app
 * serving the document through WKURLSchemeHandler or Android's shouldInterceptRequest
 * supplies the bytes itself, and those paths buffer, so "the initial response is the
 * first frames" stops being true and there is no HTTP layer underneath at all.
 */
export type Transport = 'stream' | 'buffered' | 'socket'

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

export interface ServerCapabilities {
  warp: string
  ir: string
  forms: WireForm[]
}

export const SERVER_DEFAULTS: ServerCapabilities = {
  warp: WARP_VERSION,
  ir: '1.0.0',
  forms: ['html', 'bundle', 'split', 'patch', 'data', 'delta'],
}

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
export function negotiate(hello: ClientHello, server: ServerCapabilities = SERVER_DEFAULTS): Negotiation {
  const downgrades: string[] = []

  const transport: Transport = hello.transport ?? 'stream'
  const base = {
    spec: WARP_SPEC,
    strategy: (transport === 'socket' ? 'socket' : transport === 'buffered' ? 'collapse' : 'stream') as Negotiation['strategy'],
    fill: (hello.dsd === false ? 'script' : 'dsd') as Negotiation['fill'],
    commit: (hello.vt === false ? 'instant' : 'view-transition') as Negotiation['commit'],
    residency: (hello.sw ? 'service-worker' : hello.idb ? 'indexeddb' : 'http-cache') as Negotiation['residency'],
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
  if (base.fill === 'script') {
    downgrades.push('incremental DSD parsing unavailable: holes fill via the ~1 KB filler script')
  }
  if (base.commit === 'instant') {
    downgrades.push('no same-document View Transitions: an epoch commit is an instant swap, not an animated one')
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
