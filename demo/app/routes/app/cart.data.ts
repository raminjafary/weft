import { defineRoute } from '@weftjs/core'
import { cartValues } from '../../lib/data.ts'
import { field, panel, pick } from '../../lib/controls.ts'
import { LOG } from '../../lib/showcase.ts'

/** A cart: one private fragment inside a shared document. Three write paths — optimistic channel, plain form, and a deliberate failure to press. */
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
  ) +
  panel(
    [
      `<button type="button" id="cart-checkout" data-weft-intent="cart.checkout" data-weft-payload='{"sku":"OIL-2L"}'>check out (capability + signature)</button>`,
      `<form method="post" action="/_weft/i/cart.checkout" class="controls">
       <input type="hidden" name="sku" value="OIL-2L">
       <button type="submit">check out with no JavaScript</button>
     </form>`,
    ].join(''),
    'cart.checkout is gated twice: it declares cart:checkout, which weft.config.ts grants, and it is signed — so the button fetches a token bound to this reader and this payload before it dispatches, and the frame log shows the extra round trip. The form beside it cannot fetch anything and is refused with E_INTENT_UNSIGNED, which is the price of the strongest gate: a token cannot be rendered into a page, because a page can be cached and a token cannot.',
  ) +
  `<div class="card">${LOG}</div>`

export default defineRoute({
  head: { title: 'A cart, which is the hard case · weft demo' },
  layoutValues: {
    heading: 'A cart, which is the hard case',
    shows:
      'One private fragment inside a shared document. The document stays shared; only this region is per-user.',
    control:
      'Add a line three ways: over the channel, deliberately failing, and with no JavaScript at all. Then check out, which is gated by a capability and a signature.',
    status: 'live',
  },
  // Runs in phase A, a real redirect. `?anonymous` matters: without it, a guard that only checks the
  // cookie sends every first visitor (nothing here signs you in) into an infinite redirect loop.
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
