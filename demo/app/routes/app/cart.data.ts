import { defineRoute } from 'weft'
import { cartValues } from '../../lib/data.ts'
import { field, panel, pick } from '../../lib/controls.ts'
import { LOG } from '../../lib/showcase.ts'

/**
 * A cart, which is the hard case: one private fragment inside a shared document.
 *
 * The three buttons are the three ways to write. `data-weft-intent` goes over the channel with an
 * optimistic guess staged into an epoch; the plain form posts to the same intent and gets a 303;
 * and the failing one is there so the rollback path is something you can press.
 */
const PANEL =
  panel(
    [
      field('sku', pick('cart-sku', ['RICE-5K', 'DATE-1K', 'OIL-2L', 'TEA-500', 'SUGAR-2K'])),
      `<button type="button" id="cart-add" data-weft-intent="cart.add" data-weft-payload='{"sku":"OIL-2L","qty":1}'>add (channel, optimistic)</button>`,
      `<button type="button" id="cart-fail" data-weft-intent="cart.add" data-weft-payload='{"sku":"OIL-2L","qty":1,"fail":true}'>add, but make it fail</button>`,
      `<form method="post" action="/_weft/i/cart.add" class="controls">
       <input type="hidden" name="sku" value="OIL-2L">
       <input type="hidden" name="qty" value="1">
       <button type="submit">add with no JavaScript</button>
     </form>`,
    ].join(''),
    'The last button is a plain form post to the same intent. It answers with a 303 back to this page, which is the whole progressive-enhancement story.',
  ) + `<div class="card">${LOG}</div>`

export default defineRoute({
  head: { title: 'A cart, which is the hard case · weft demo' },
  layoutValues: {
    heading: 'A cart, which is the hard case',
    shows:
      'One private fragment inside a shared document. The document stays shared; only this region is per-user.',
    control: 'Add a line three ways: over the channel, deliberately failing, and with no JavaScript at all.',
    status: 'live',
  },
  /**
   * Runs in phase A, where the envelope is still open — so this redirect is a real redirect.
   *
   * The second half is not decoration. Nothing in this demo signs you in, so a guard that only
   * asked for the cookie sent every visitor to a URL whose guard asked for it again: the page was
   * an infinite redirect for anyone arriving without one, which is every first visit. The point
   * being demonstrated is that a guard decides before a byte is rendered, and it survives being
   * demonstrated once.
   */
  guard: (ctx) => Boolean(ctx.cookie('sid') ?? ctx.query('anonymous')),
  redirect: '/app/cart?anonymous=1',
  slots: {
    panel: { fragment: 'markup', stream: false, html: PANEL },
    // Reads identity, so `private` is the only policy the compiler will accept. Declaring
    // `public` here fails the build and names `identity`.
    body: {
      fragment: 'cart',
      stream: { prio: 1 },
      cache: { class: 'private', tags: ['cart'] },
      live: true,
      load: async (ctx) => {
        const session = ctx.cookie('sid') ?? 'demo-shared'
        const user = (await ctx.user()) ?? 'guest'
        return { ...cartValues(session, ctx.cookie('currency') ?? 'IQD'), user }
      },
    },
    readout: {
      fragment: 'greeting',
      stream: false,
      cache: { class: 'private' },
      load: async (ctx) => ({
        user: (await ctx.user()) ?? 'guest',
        tier: ctx.header('x-tier') ?? 'standard',
      }),
    },
  },
})
