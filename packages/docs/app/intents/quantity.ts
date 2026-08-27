import { defineIntent } from '@weft/core'

/**
 * What makes the signals example on `/guide/the-client` respond to typing.
 *
 * The example is a client-owned signal read by four nodes, and it was one-way: the signal wrote the
 * input, and nothing wrote the signal. That is not a gap in the example so much as the architecture
 * being consistent — `WiringOp` has exactly one inbound op, `event`, and `adopt.ts` refuses an
 * `event` entry that does not name an intent:
 *
 *     if (!entry.event || !entry.intent) continue
 *
 * There is no op that writes a signal from a DOM event directly, because the alternative is a
 * closure on the wire. So a signal a reader can change needs an intent, and without one the example
 * on the page about adoption was a control that could not be operated.
 *
 * This intent does nothing on the server, and that is the honest shape rather than a shortcut. The
 * repaint a reader sees is `boot.ts`'s local half of an optimistic write — the control that fired
 * updates the signal now, and the four bindings that read it recompute — so what this module
 * supplies is the *binding*, not the arithmetic. `writes: []` says so: nothing is cached on the
 * strength of a quantity, so there is nothing to invalidate and no tag to declare.
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
