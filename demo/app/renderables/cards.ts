import { defineRenderable } from '@weftjs/core'
import { catalogue } from '../lib/data.ts'

/** The catalogue: what a browser on this deployment may ask to have rendered. See `spec/kernel/authority.md`. */
export const productCard = defineRenderable<{ sku: string }>({
  name: 'card.product',
  fragment: 'product-card',
  /** Validated before anything renders — an unvalidated `sku` is an unvalidated hole. `E_RENDER_INPUT`, a 422. */
  input: (raw) => {
    const sku = String((raw as { sku?: unknown }).sku ?? '')
    if (!catalogue(sku)) throw new Error(`${sku} is not a product`)
    return { sku }
  },
  /** Costs server work and writes nothing, so it's the one call here that most wants a limit. */
  limit: { max: 60, windowMs: 10_000 },
  load: (_ctx, { sku }) => {
    const item = catalogue(sku)
    return {
      sku,
      name: item?.name ?? sku,
      price: item?.price ?? 0,
      unit: 'IQD',
      badge: 'asked for by name',
      available: true,
      cart: '',
    }
  },
})

/** The same catalogue entry, served by a region on another deployment — names no fragment, only a region. */
export const remoteSearch = defineRenderable<{ q: string }>({
  name: 'card.search',
  region: 'search',
  input: (raw) => ({ q: String((raw as { q?: unknown }).q ?? '').slice(0, 40) }),
})
