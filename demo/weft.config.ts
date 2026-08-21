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
   * application. This one has forty pages and thirty-four of them are stations reachable from the
   * index — so which six belong in the chrome is an editorial decision, and it is made here.
   */
  nav: [
    { href: '/', label: 'Stations' },
    { href: '/app/ordinary/pantry', label: 'Ordinary page' },
    { href: '/app/feed', label: 'Feed' },
    { href: '/app/cart', label: 'Cart' },
    { href: '/app/dashboard', label: 'Dashboard' },
    { href: '/app/article', label: 'Article' },
    { href: '/spec', label: 'Coverage' },
  ],
})
