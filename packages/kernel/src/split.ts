import { renderHole, type Resolver, type TemplateIR, type Values } from '../../ir/src/index.ts'

const utf8 = new TextEncoder()

export interface SlotSplit {
  /** Constant regions of the shell. There is always one more chunk than there are slots. */
  chunks: Uint8Array[]
  /** The binding name of each slot, in document order. */
  slots: string[]
}

/**
 * Cuts the shell at its slot holes. Everything between two slots is bytes the server can
 * send before it knows anything about the slow work, which is the whole reason a slot
 * exists: a fragment that reads something slow becomes a hole by construction, so the
 * shell is never downstream of the query.
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
    if (hole.kind === 'slot') {
      flush()
      slots.push(hole.binding)
      continue
    }
    pending.push(renderHole(hole, values[hole.binding], resolve))
  }
  flush()

  return { chunks, slots }
}

export function anchorFor(slot: string): Uint8Array {
  return utf8.encode(`<!--w:${slot}-->`)
}
