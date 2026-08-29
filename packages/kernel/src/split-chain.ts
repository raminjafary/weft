import type { TemplateIR } from '@weftjs/ir'
import { splitAtSlots, type SlotSplit, type Splitter } from './split.ts'

/**
 * One document nested inside another: a layout chain, outermost first. `at` is the slot hole of
 * the enclosing template this link fills — a slot rather than a component instance, since a
 * component hole is rendered inline and its slots would never be seen. Every link shares the
 * enclosing render's value set and resolver.
 */
export interface ShellLink {
  at: string
  template: TemplateIR
}

/**
 * The inner document's cut, put where the outer one left a hole for it. The hole at `at` stops
 * being a boundary, keeping the "one more chunk than slots" invariant true of the result.
 */
function join(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const part of parts) total += part.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function spliceAt(outer: SlotSplit, at: number, inner: SlotSplit): SlotSplit {
  const middle = [...inner.chunks]
  const last = middle.length - 1
  middle[0] = join([outer.chunks[at] as Uint8Array, middle[0] as Uint8Array])
  middle[last] = join([middle[last] as Uint8Array, outer.chunks[at + 1] as Uint8Array])
  return {
    chunks: [...outer.chunks.slice(0, at), ...middle, ...outer.chunks.slice(at + 2)],
    slots: [...outer.slots.slice(0, at), ...inner.slots, ...outer.slots.slice(at + 1)],
  }
}

/**
 * A splitter for a route whose document is a chain of layouts. Built on the flat splitter: each
 * layer is cut the way any document is, and the cuts are spliced together, so nothing downstream
 * can tell a chain from a single document. A link whose `at` is not a boundary is left unspliced
 * rather than throwing — that check already happened twice, in the plan layer and the generator.
 */
export function chainSplitter(links: readonly ShellLink[]): Splitter {
  return (ir, values, resolve) => {
    const split = (template: TemplateIR, depth: number): SlotSplit => {
      const base = splitAtSlots(template, values, resolve)
      const link = links[depth]
      if (!link) return base
      const at = base.slots.indexOf(link.at)
      if (at < 0) return base
      return spliceAt(base, at, split(link.template, depth + 1))
    }
    return split(ir, 0)
  }
}
