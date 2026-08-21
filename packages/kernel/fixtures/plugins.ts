import { definePlugin, type Plugin } from '../src/plugins.ts'

/**
 * A realistic plugin set, because the interesting properties of this layer only appear with
 * more than two plugins in it: an inferred edge, a wave of genuinely disjoint work, a filter
 * that ends the request before any of it runs, and an ordering that data flow cannot express.
 *
 * Nothing here declares an integer priority, and nothing here can write a cache key.
 */
export const session = definePlugin({
  name: '@weft/session',
  role: 'enricher',
  reads: ['cookie:sid'],
  provides: ['ctx.session'],
  onRequest: (ctx) => ({ provided: { 'ctx.session': ctx.cookie('sid') ?? null } }),
})

/** Reads what session provides, so the edge exists without anybody writing `after`. */
export const i18n = definePlugin({
  name: '@weft/i18n',
  role: 'enricher',
  reads: ['cookie:locale', 'header:accept-language', 'ctx.session'],
  provides: ['ctx.locale'],
  planAxis: () => ({ locale: ['en', 'ar', 'ku'] }),
  onRequest: (ctx) => ({
    provided: { 'ctx.locale': ctx.cookie('locale') ?? ctx.header('accept-language')?.slice(0, 2) ?? 'en' },
  }),
})

/** Disjoint from everything: no reads anybody provides, so it shares a wave with session. */
export const tracing = definePlugin({
  name: '@weft/tracing',
  role: 'enricher',
  reads: ['header:traceparent'],
  provides: ['ctx.trace'],
  onRequest: (ctx) => ({ provided: { 'ctx.trace': ctx.header('traceparent') ?? 'root' } }),
})

/**
 * A CSP nonce has to be injected before anything adds a script tag, and no read/write
 * relationship captures that. This is what `before` is for, and why it stays rare.
 */
export const csp = definePlugin({
  name: '@weft/csp',
  role: 'enricher',
  before: ['@acme/analytics'],
  provides: ['ctx.nonce'],
  onRequest: () => ({ provided: { 'ctx.nonce': 'n0nce' } }),
})

export const analytics = definePlugin({
  name: '@acme/analytics',
  role: 'enricher',
  residency: 'both',
  reads: ['ctx.nonce', 'device'],
  critical: false,
  timeoutMs: 20,
  capabilities: ['network'],
  onRequest: (ctx) => {
    ctx.device()
  },
})

/** A filter, because it can end the request. Sequential, phase A, may write the envelope. */
export const auth = definePlugin({
  name: '@weft/auth',
  role: 'filter',
  reads: ['cookie:sid'],
  onRequest: (ctx) => {
    if (ctx.cookie('sid')) return
    return { response: new Response(null, { status: 302, headers: { location: '/login' } }) }
  },
})

export const stack: Plugin[] = [analytics, csp, i18n, session, tracing]
export const gated: Plugin[] = [auth, ...stack]

/** Plugin sets that must be refused, one per rule the layer exists to enforce. */
export const rejected: Record<string, Plugin[]> = {
  ambiguous: [i18n, definePlugin({ name: 'other-i18n', role: 'enricher', provides: ['ctx.locale'] })],
  cyclic: [
    definePlugin({ name: 'a', role: 'enricher', before: ['b'] }),
    definePlugin({ name: 'b', role: 'enricher', before: ['a'] }),
  ],
  duplicated: [i18n, i18n],
}

/** Plugins that misbehave at runtime rather than at registration. */
export const misbehaving = {
  undeclaredRead: definePlugin({
    name: 'sneaky',
    role: 'enricher',
    critical: true,
    reads: ['cookie:locale'],
    onRequest: (ctx) => {
      ctx.user()
    },
  }),
  undeclaredProvide: definePlugin({
    name: 'generous',
    role: 'enricher',
    critical: true,
    onRequest: () => ({ provided: { 'ctx.surprise': 1 } }),
  }),
  respondingEnricher: definePlugin({
    name: 'overreaching',
    role: 'enricher',
    onRequest: () => ({ response: new Response('no') }),
  }),
  slow: definePlugin({
    name: 'slow',
    role: 'enricher',
    timeoutMs: 5,
    onRequest: () => new Promise<void>((resolve) => setTimeout(resolve, 60)),
  }),
  failing: definePlugin({
    name: 'third-party',
    role: 'enricher',
    critical: false,
    onRequest: () => {
      throw new Error('third party down')
    },
  }),
}
