import { bindingExecutor, bySession, defineConfig, generateSigningKeys, regionService } from '@weftjs/core'

/**
 * A signing key, generated on boot.
 *
 * Right for a demo and wrong for a deployment, which is the interesting half: a restart here
 * invalidates every token in flight, because the key that could check them is gone. A deployment
 * holds its keys somewhere it can rotate — `publicKeys` is a bundle by id precisely so a new key
 * can be added before the old one is retired — and the config is the only place that changes.
 */
const dev = await generateSigningKeys()

/**
 * What the demo binds.
 *
 * One flag axis, because the cart station reads `new-cart` and a flag that is not declared cannot
 * be read — so a typo is a build error rather than a branch that silently never runs. Everything
 * else is the default: an in-process store, a cookie session, and `inline` as the only executor.
 * That is a real single-process deployment, and it is what the hand-written server bound too.
 */
/**
 * The search deployment, as this deployment reaches it.
 *
 * A binding rather than a URL, because a demo that needed a second process running would be a demo
 * that is usually broken — and the point being made is not that a socket works. `bindingExecutor` is
 * a real crash-domain boundary either way: the region is serialised to a job, posted, and answered
 * with a Warp stream that the composite checks frame by frame before any of it reaches the page.
 * Swapping this line for `svcExecutor({ url })` is the whole difference between the two topologies.
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
  flags: { 'new-cart': ['off', 'on'] },
  executors: { 'binding:search': searchTier },
  /**
   * What a call is counted against, which is the one thing a kernel refuses to guess.
   *
   * A session here, because that is what this demo has: nothing signs you in, and an address on a
   * laptop is one address. A deployment behind a CDN would write `byAddress()`; one where every
   * caller has a subject would write `bySubject()`. All three are one line, and choosing between
   * them is a property of the deployment rather than of the intent.
   *
   * Supplying `counted` and nothing else means the framework counts, against the store this
   * deployment already bound. A deployment with its own limiter — a gateway, a Redis script — passes
   * a `LimitPort` here instead and nothing else changes.
   */
  limits: { counted: bySession('sid') },
  /**
   * Where `search` is, which is the one fact a page composing it deliberately does not state.
   *
   * Point `export` at `searchAhead` and reload: the region announces a contract this shell was not
   * built against, the arrival check refuses it, and the page shows its declared fallback with the
   * versions named. Nothing is rebuilt in between, which is the property the registry exists for.
   */
  regions: [
    {
      region: 'search',
      executor: 'binding:search',
      address: { module: './search-region.ts', export: 'search' },
      contract: { id: 'search', version: '2.1.0', reads: ['route:q'] },
      revision: 'search-42',
    },
  ],
  /**
   * The nav, stated rather than derived.
   *
   * Without this the framework links every parameterless route, which is right for a small
   * application and wrong here for two reasons: three of these pages take a parameter, so the
   * framework cannot know which instance belongs in the chrome, and the demo's own index is the
   * page that introduces them. So the list is stated, and a test asserts that every route in the
   * file tree is reachable from it or from the index.
   */
  /**
   * Where a route change lands.
   *
   * `preserve` because of what these pages are: the ordinary page's two categories are the same
   * layout with different content, and a reader comparing them is somewhere in the middle of the
   * list. `top` — the default, and what a navigation has always done — sent them back to the
   * chrome on every switch. Back and forward ignore this either way and restore the position
   * recorded on the entry being returned to.
   */
  navigation: { scroll: 'preserve' },
  /**
   * Who may run an intent here.
   *
   * `cart.checkout` declares `cart:checkout`, and this is the row that makes it reachable. Nothing
   * in this demo signs you in, so the grant is on `anonymous` — delete that line and every
   * checkout becomes `E_CAPABILITY_DENIED` with the missing capability named, which is the whole
   * behaviour worth demonstrating: the framework refuses, and the config is where the answer lives.
   */
  authority: {
    grants: { anonymous: ['cart:checkout'], user: ['cart:checkout'] },
    signing: { kid: 'dev', privateKey: dev.privateKey, publicKeys: { dev: dev.publicKey } },
  },
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
