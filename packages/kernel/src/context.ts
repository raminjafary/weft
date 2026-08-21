import type { Envelope, DeferredEffect } from './envelope.ts'
import type { FlagValue, Ports, RequestFacts, SetCookie } from './ports.ts'

/**
 * The runtime half of effect tracking. The compiler records *which* reads taint a
 * fragment; this resolves their values, and it has to mirror the compiler's read surface
 * exactly — a read the compiler tracks and the kernel cannot resolve would produce a cache
 * key that does not describe the render.
 */
export interface Reads {
  flag(name: string): Promise<FlagValue>
  cookie(key: string): string | undefined
  header(key: string): string | undefined
  param(key: string): string | undefined
  query(key: string): string | undefined
  locale(): string
  device(): string
  user(): Promise<string | null>
  now(): number
  /** The escape hatch. Taints `opaque`, which makes the fragment private and uncacheable. */
  raw<T>(fn: (facts: RequestFacts) => T): T
  /** Everything actually read, in the order it was read. */
  taints(): string[]
}

export interface ReadOptions {
  clock?: () => number
}

export function createReads(facts: RequestFacts, ports: Ports, options: ReadOptions = {}): Reads {
  const seen = new Set<string>()
  const order: string[] = []
  const clock = options.clock ?? (() => Date.now())

  const taint = (read: string): void => {
    if (seen.has(read)) return
    seen.add(read)
    order.push(read)
  }

  return {
    taints: () => [...order],
    async flag(name) {
      taint(`flag:${name}`)
      return ports.flags.resolve(name, facts)
    },
    cookie(key) {
      taint(`cookie:${key}`)
      return ports.session.cookie(facts, key)
    },
    header(key) {
      taint(`header:${key}`)
      return facts.headers.get(key) ?? undefined
    },
    param(key) {
      taint(`route:${key}`)
      return facts.params[key]
    },
    query(key) {
      taint(`route:${key}`)
      return facts.url.searchParams.get(key) ?? undefined
    },
    locale() {
      taint('locale')
      return localeOf(facts)
    },
    device() {
      taint('device')
      return deviceOf(facts)
    },
    async user() {
      taint('identity')
      return ports.session.identity(facts)
    },
    now() {
      taint('time')
      return clock()
    },
    raw(fn) {
      taint('opaque')
      return fn(facts)
    },
  }
}

/** Coarse on purpose. A high-cardinality device string would be a high-cardinality cache key. */
export function deviceOf(facts: RequestFacts): string {
  const mobile = facts.headers.get('sec-ch-ua-mobile')
  if (mobile === '?1') return 'mobile'
  if (mobile === '?0') return 'desktop'
  return /mobi|android|iphone|ipad/i.test(facts.headers.get('user-agent') ?? '') ? 'mobile' : 'desktop'
}

export function localeOf(facts: RequestFacts): string {
  const header = facts.headers.get('accept-language')
  if (!header) return 'en'
  const first = header.split(',')[0]?.split(';')[0]?.trim()
  return first && first !== '*' ? first.toLowerCase() : 'en'
}

/**
 * Phase A. The only context that can touch the envelope, and it is deliberately a
 * different type from the one a render receives rather than the same object with a flag on
 * it — a flag can be checked in the wrong place.
 */
export interface EnvelopeContext extends Reads {
  readonly phase: 'envelope'
  setCookie(cookie: SetCookie): void
  status(code: number): void
  redirect(location: string, code?: number): void
  /** Ends the request here, with no body. What a guard does when it says no. */
  refuse(code: number): void
  setHeader(name: string, value: string): void
}

/**
 * Phase B. No envelope methods at all, except the one that admits it is late: a deferrable
 * effect is queued for the next request on the connection, and is dropped if there is no
 * next request.
 */
export interface RenderContext extends Reads {
  readonly phase: 'render'
  defer(effect: DeferredEffect): void
}

export function envelopeContext(reads: Reads, envelope: Envelope): EnvelopeContext {
  return {
    ...reads,
    phase: 'envelope',
    setCookie: (cookie) => envelope.setCookie(cookie),
    status: (code) => envelope.status(code),
    redirect: (location, code) => envelope.redirect(location, code),
    refuse: (code) => envelope.refuse(code),
    setHeader: (name, value) => envelope.header(name, value),
  }
}

export function renderContext(reads: Reads, envelope: Envelope): RenderContext {
  return {
    ...reads,
    phase: 'render',
    defer: (effect) => envelope.deferrable(effect),
  }
}
