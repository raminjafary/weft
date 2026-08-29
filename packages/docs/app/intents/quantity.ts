import { defineIntent } from '@weftjs/core'

/**
 * What makes the signals example on `/guide/the-client` respond to typing. A DOM event can only
 * write a signal through an intent — there's no op that does it directly, since the alternative is
 * a closure on the wire. See `spec/ir/template-ir-2.md`: Wiring table.
 *
 * This intent does nothing on the server: the repaint is `boot.ts`'s local half of an optimistic
 * write, so this module supplies only the binding. `writes: []` — nothing is cached on a quantity.
 */
export const quantity = defineIntent<{ qty: number }>({
  name: 'docs.quantity',
  writes: [],
  input: (raw) => {
    const body = raw as { qty?: unknown }
    const qty = Number(body.qty ?? 0)
    if (!Number.isFinite(qty)) throw new Error('qty must be a number')
    // The example's input declares `min="0"`, and an intent cannot trust an attribute.
    return { qty: Math.max(0, Math.trunc(qty)) }
  },
  run() {
    // Deliberately empty. The signal is the client's; the server has no copy to update and
    // pretending otherwise would be a demonstration of something this site does not do.
  },
})
