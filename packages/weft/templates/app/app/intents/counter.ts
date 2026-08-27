import { defineIntent } from '@weft/core'

/**
 * A mutation. It runs on the server, it declares what it writes, and the client never carries its
 * name — the compiler derives an opaque id from this module and export, and that id is what goes
 * on the wire.
 *
 * `writes` is not documentation. An intent that touches state it did not declare is refused, and
 * the declaration is what tells every open connection which regions just went stale.
 */
let count = 0

export function read(): number {
  return count
}

export const bump = defineIntent<{ by: number }>({
  name: 'counter.bump',
  writes: ['counter'],
  // Input is validated here or it is not validated. A body that arrived over the wire is not a
  // type, whatever the annotation says.
  input: (raw) => {
    const body = raw as { by?: unknown }
    const by = Number(body.by ?? 1)
    if (!Number.isFinite(by)) throw new Error('by has to be a number')
    return { by: Math.trunc(by) }
  },
  async run(ctx, input) {
    count += input.by
    await ctx.revalidate('counter')
    return { refresh: ['body'], data: { count } }
  },
})

export const reset = defineIntent({
  name: 'counter.reset',
  writes: ['counter'],
  async run(ctx) {
    count = 0
    await ctx.revalidate('counter')
    return { refresh: ['body'] }
  },
})
