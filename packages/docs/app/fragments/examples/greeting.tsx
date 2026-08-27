import { fragment, type Ctx } from '@weftjs/core'

/**
 * A fragment that reads the request, and therefore keys on it.
 *
 * `ctx.cookie('currency')` taints `cookie:currency`, so this fragment's cache entry is per currency
 * and the response says `Vary: Cookie`. Nothing declares that. Every read here is a call the
 * compiler can name statically, which is why a read it cannot name is a build error rather than a
 * cache key with a hole in it.
 */
export default fragment(async (ctx: Ctx) => {
  const currency = ctx.cookie('currency') ?? 'USD'
  return <p class="greeting">Prices shown in {currency}.</p>
})
