import { renderHole, type Resolver, type TemplateIR, type Values } from '@weft/ir'

const utf8 = new TextEncoder()

/** A document cut at its boundaries: the constant chunks, and the slot between each pair. */
export interface SlotSplit {
  /** Constant regions of the shell. There is always one more chunk than there are slots. */
  chunks: Uint8Array[]
  /** The binding name of each slot, in document order. */
  slots: string[]
}

/**
 * How a document is cut into what can be sent now and what has to wait.
 *
 * A type rather than a call, because there is a second implementation: a route wrapped in nested
 * layouts is cut across the whole chain, and that splicing lives in `split-chain.ts` so that a
 * deployment whose layouts are flat does not import it. See `spec/kernel/budgets.md` — this is the
 * third time the byte budget has turned a capability into a seam, and the seam is the better shape
 * each time.
 */
export type Splitter = (ir: TemplateIR, values: Values, resolve?: Resolver) => SlotSplit

/**
 * Cuts the shell at its slot holes, and at every instance the compiler isolated. Everything
 * between two of them is bytes the server can send before it knows anything about the slow
 * work, which is the whole reason a slot exists: a fragment that reads something slow
 * becomes a hole by construction, so the shell is never downstream of the query. An
 * isolated instance is the same cut made for a different reason — the child is private and
 * the shell is not, so they cannot share one cache entry.
 */
export function splitAtSlots(ir: TemplateIR, values: Values, resolve?: Resolver): SlotSplit {
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
    // A slot and an isolated instance are the same shape of hole: bytes this render does
    // not own. One was left for slow work, the other for work with a different cache
    // class, and the shell is sent before either resolves.
    if (hole.kind === 'slot' || hole.isolated) {
      flush()
      slots.push(hole.binding)
      continue
    }
    pending.push(renderHole(hole, values[hole.binding], resolve))
  }
  flush()

  return { chunks, slots }
}

/** The comment left in a hole for out-of-order delivery, which the fill script finds by walking. */
export function anchorFor(slot: string): Uint8Array {
  return utf8.encode(`<!--w:${slot}-->`)
}
