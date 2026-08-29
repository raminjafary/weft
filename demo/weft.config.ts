import { bindingExecutor, bySession, defineConfig, generateSigningKeys, regionService } from '@weftjs/core'

/** A signing key, generated on boot. Right for a demo, wrong for a deployment: a restart invalidates every token in flight. See `spec/kernel/authority.md`. */
const dev = await generateSigningKeys()

/**
 * The search deployment, as this deployment reaches it. A binding rather than a URL, so the demo
 * needs no second process running. `bindingExecutor` is a real crash-domain boundary either way —
 * swapping this for `svcExecutor({ url })` is the whole difference between the two topologies.
 */
const searchTier = bindingExecutor({
  binding: regionService({
    root: new URL('./app/lib/', import.meta.url).href,
    revision: 'search-42',
  }),
  name: 'binding:search',
  // A budget on a boundary is a deadline on waiting. The other end cannot be killed from here.
  timeoutMs: 500,
})

export default defineConfig({
  port: 4173,
  // One flag axis: the cart station reads `new-cart`, and an undeclared flag cannot be read.
  flags: { 'new-cart': ['off', 'on'] },
  executors: { 'binding:search': searchTier },
  /** What a call is counted against — a session here, since nothing signs you in. See `spec/kernel/authority.md`. */
  limits: { counted: bySession('sid') },
  /** Where `search` is, which a page composing it deliberately does not state. See `spec/kernel/composition.md`. */
  regions: [
    {
      region: 'search',
      executor: 'binding:search',
      address: { module: './search-region.ts', export: 'search' },
      contract: { id: 'search', version: '2.1.0', reads: ['route:q'] },
      revision: 'search-42',
    },
  ],
  /** Where a route change lands. `preserve`, since the ordinary page's categories are one layout a reader compares. See `spec/client/navigation.md`. */
  navigation: { scroll: 'preserve' },
  /** Who may run an intent here. Delete the `anonymous` grant and checkout becomes `E_CAPABILITY_DENIED`. */
  authority: {
    grants: { anonymous: ['cart:checkout'], user: ['cart:checkout'] },
    signing: { kid: 'dev', privateKey: dev.privateKey, publicKeys: { dev: dev.publicKey } },
  },
  // Stated rather than derived: three of these pages take a parameter, so the framework can't pick which instance belongs in the chrome.
  nav: [
    { href: '/', label: 'The six' },
    { href: '/app/ordinary/pantry', label: 'Ordinary page' },
    { href: '/app/feed', label: 'Feed' },
    { href: '/app/cart', label: 'Cart' },
    { href: '/app/dashboard', label: 'Dashboard' },
    { href: '/app/article', label: 'Article' },
    { href: '/live/race/out-of-order', label: 'Streaming race' },
    { href: '/app/composed', label: 'Composed' },
    { href: '/docs', label: 'Docs' },
  ],
})
