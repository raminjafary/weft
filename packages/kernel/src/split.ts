import { renderHoleIn, resolveDerived, type Resolver, type TemplateIR, type Values } from '@weftjs/ir'

const utf8 = new TextEncoder()

/** A document cut at its boundaries: the constant chunks, and the slot between each pair. */
export interface SlotSplit {
  /** Constant regions of the shell. There is always one more chunk than there are slots. */
  chunks: Uint8Array[]
  /** The binding name of each slot, in document order. */
  slots: string[]
}

/**
 * How a document is cut into what can be sent now and what has to wait. A type rather than a
 * call: a route wrapped in nested layouts is cut across the whole chain in `split-chain.ts`, so a
 * deployment whose layouts are flat does not import it. See `spec/kernel/budgets.md`.
 */
export type Splitter = (ir: TemplateIR, values: Values, resolve?: Resolver) => SlotSplit

/**
 * Cuts the shell at its slot holes, and at every instance the compiler isolated — bytes the
 * server can send before it knows anything about the slow work. An isolated instance is the same
 * cut for a different reason: the child is private and the shell is not.
 */
export function splitAtSlots(ir: TemplateIR, values: Values, resolve?: Resolver): SlotSplit {
  // The derived values, first — the same step `writeTemplate` takes before it writes a byte.
  // A conditional or template literal lowers to a hole bound to a derived id, in `ir.derived`
  // rather than in the values the route supplied. Without this it rendered empty.
  const resolved = resolveDerived(ir.derived, values)
  const chunks: Uint8Array[] = []
  const slots: string[] = []
  let pending: Uint8Array[] = []

  const flush = (): void => {
    let total = 0
    for (const part of pending) total += part.length
    const out = new Uint8Array(total)
    let offset = 0
    for (const part of pending) {
      out.set(part, offset)
      offset += part.length
    }
    chunks.push(out)
    pending = []
  }

  for (let i = 0; i < ir.segments.length; i++) {
    pending.push(ir.segments[i] as Uint8Array)
    const hole = ir.holes[i]
    if (!hole) continue
    // A slot and an isolated instance are the same shape of hole: bytes this render does not
    // own, sent before either resolves.
    if (hole.kind === 'slot' || hole.isolated) {
      flush()
      slots.push(hole.binding)
      continue
    }
    // The whole value set, not one value: a component instance projects several of the
    // parent's bindings through its props. See `renderHoleIn`.
    pending.push(renderHoleIn(hole, resolved, resolve))
  }
  flush()

  return { chunks, slots }
}

/** The comment left in a hole for out-of-order delivery, which the fill script finds by walking. */
export function anchorFor(slot: string): Uint8Array {
  return utf8.encode(`<!--w:${slot}-->`)
}
