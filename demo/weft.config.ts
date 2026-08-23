import { defineConfig } from 'weft'

/**
 * What the demo binds.
 *
 * One flag axis, because the cart station reads `new-cart` and a flag that is not declared cannot
 * be read — so a typo is a build error rather than a branch that silently never runs. Everything
 * else is the default: an in-process store, a cookie session, and `inline` as the only executor.
 * That is a real single-process deployment, and it is what the hand-written server bound too.
 */
export default defineConfig({
  port: 4173,
  flags: { 'new-cart': ['off', 'on'] },
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
  nav: [
    { href: '/', label: 'The five' },
    { href: '/app/ordinary/pantry', label: 'Ordinary page' },
    { href: '/app/feed', label: 'Feed' },
    { href: '/app/cart', label: 'Cart' },
    { href: '/app/dashboard', label: 'Dashboard' },
    { href: '/app/article', label: 'Article' },
    { href: '/live/race/out-of-order', label: 'Streaming race' },
  ],
})
