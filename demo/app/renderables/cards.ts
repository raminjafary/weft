import { defineRenderable } from '@weftjs/core'
import { catalogue } from '../lib/data.ts'

/**
 * The catalogue: what a browser on this deployment may ask to have rendered.
 *
 * A directory rather than a declaration, because what is in it is the security boundary. Every
 * fragment under `app/fragments/` is something a page composes; every entry here is something a
 * *client* can name — and if those two sets were one set, every component in the application would
 * be a public endpoint taking arbitrary props.
 *
 * The id on the wire is six hex characters derived from this file's path and the export's name. It is
 * not `product-card`, it is not a path, and it discloses nothing about what runs. Moving this file
 * changes it, deliberately: an entry's location is part of its address, the same rule intents live
 * under.
 */
export const productCard = defineRenderable<{ sku: string }>({
  name: 'card.product',
  fragment: 'product-card',
  /**
   * Validated before anything renders, because these params came from a browser.
   *
   * The same gate an intent's `input` is, and for a stronger reason: an intent's payload reaches code
   * somebody wrote to expect it, and this one reaches a *template* — so an unvalidated `sku` is an
   * unvalidated hole. Throwing here is `E_RENDER_INPUT` and a 422's worth of meaning, not a 500.
   */
  input: (raw) => {
    const sku = String((raw as { sku?: unknown }).sku ?? '')
    if (!catalogue(sku)) throw new Error(`${sku} is not a product`)
    return { sku }
  },
  /**
   * The one call a client can make that costs server work and writes nothing, so it is the one that
   * most wants a limit. What it is counted against is `weft.config.ts`'s, as everywhere else.
   */
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

/**
 * The same catalogue entry, served by a region on another deployment.
 *
 * Here to make the indirection something you can see rather than something the comments claim: this
 * entry names no fragment at all, only a region — so which deployment renders it is a registry write,
 * and the client, holding an opaque id, is not involved in either arrangement.
 */
export const remoteSearch = defineRenderable<{ q: string }>({
  name: 'card.search',
  region: 'search',
  input: (raw) => ({ q: String((raw as { q?: unknown }).q ?? '').slice(0, 40) }),
})
