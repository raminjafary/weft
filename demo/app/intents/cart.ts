import { defineIntent } from '@weftjs/core'
import { CATALOGUE_SKUS, cartOf, catalogue } from '../lib/data.ts'

/** The demo's mutations. Moving this file changes their ids, deliberately — an intent's location is part of the wire. See `spec/kernel/intents.md`. */
function skuOf(raw: unknown): string {
  const body = raw as { sku?: unknown }
  const sku = String(body.sku ?? '')
  if (!CATALOGUE_SKUS.includes(sku)) throw new Error(`sku must be one of ${CATALOGUE_SKUS.join(', ')}`)
  return sku
}

export const addToCart = defineIntent<{ sku: string; qty: number; fail?: boolean }>({
  name: 'cart.add',
  writes: ['cart'],
  /** How much of this the deployment can take, deliberately not from whom — that's `weft.config.ts`'s call. See `spec/kernel/authority.md`. */
  limit: { max: 20, windowMs: 10_000 },
  input: (raw) => {
    const body = raw as { qty?: unknown; fail?: unknown }
    const qty = Number(body.qty ?? 1)
    if (!Number.isFinite(qty) || qty < 0) throw new Error('qty must be a non-negative number')
    return { sku: skuOf(raw), qty, ...(body.fail ? { fail: true } : {}) }
  },
  async run(ctx, input) {
    // Deliberate failure, so the optimistic-rollback path is something you can press rather than
    // something you read about.
    if (input.fail) throw new Error('the pricing service refused this line')
    const session = ctx.cookie('sid') ?? 'demo-shared'
    for (const key of [session, 'demo-shared']) {
      const cart = cartOf(key)
      cart.set(input.sku, (cart.get(input.sku) ?? 0) + input.qty)
    }
    await ctx.revalidate('cart')
    return { refresh: ['body'], data: { sku: input.sku, name: catalogue(input.sku)?.name } }
  },
})

export const setQuantity = defineIntent<{ sku: string; qty: number }>({
  name: 'cart.setQty',
  writes: ['cart'],
  input: (raw) => {
    const body = raw as { qty?: unknown }
    return { sku: skuOf(raw), qty: Math.max(0, Number(body.qty ?? 0)) }
  },
  async run(ctx, input) {
    const session = ctx.cookie('sid') ?? 'demo-shared'
    for (const key of [session, 'demo-shared']) cartOf(key).set(input.sku, input.qty)
    await ctx.revalidate('cart')
    return { refresh: ['body'] }
  },
})

/** The one intent here that has to prove who is asking and that this deployment asked for it. See `spec/kernel/authority.md`. */
export const checkout = defineIntent<{ sku: string }>({
  name: 'cart.checkout',
  writes: ['cart'],
  capabilities: ['cart:checkout'],
  signed: true,
  input: (raw) => ({ sku: skuOf(raw) }),
  async run(ctx, input) {
    const session = ctx.cookie('sid') ?? 'demo-shared'
    for (const key of [session, 'demo-shared']) cartOf(key).delete(input.sku)
    await ctx.revalidate('cart')
    return { refresh: ['body'], data: { checkedOut: input.sku } }
  },
})
