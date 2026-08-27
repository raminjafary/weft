import type { TemplateIR } from '@weftjs/ir'
import { splitAtSlots, type SlotSplit, type Splitter } from './split.ts'

/**
 * One document nested inside another: a layout chain, outermost first.
 *
 * `at` is the slot hole of the enclosing template this link fills. A slot rather than a component
 * instance, because that is what a layout hole already is — the boundary the enclosing render does
 * not own — and because a chain has to be cut at *every* layer's holes. A component hole is
 * rendered inline by its parent, so the slots inside one would never be seen.
 *
 * Every link shares the enclosing render's value set and its resolver. A chain is one document with
 * one head: the values the framework supplies plus whatever the route added are what all of them
 * read, and a per-link namespace would mean a nested layout could not print the title.
 */
export interface ShellLink {
  at: string
  template: TemplateIR
}

/**
 * The inner document's cut, put where the outer one left a hole for it.
 *
 * The hole at `at` stops being a boundary: the bytes before it run straight into the inner
 * document's first chunk and the inner document's last runs into the bytes after it. Everything
 * between stays exactly as the inner split produced it, which is what keeps the invariant — one
 * more chunk than there are slots — true of the result.
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
 * A splitter for a route whose document is a chain of layouts.
 *
 * Built on the flat splitter rather than replacing it: each layer is cut the way any document is,
 * and the cuts are spliced together. So a nested layout's slow region streams exactly as an outer
 * one's does, in document order, and nothing downstream — the stream, the anchors, the filler, the
 * plan's slot names — can tell a chain from a single document. Nesting is a build-time shape.
 *
 * A link whose `at` is not a boundary of the layer enclosing it is left unspliced rather than
 * throwing, because the check has already been made twice where it costs nothing:
 * `E_SHELL_LINK_UNPLACED` in the plan layer and `E_NO_NESTING_SLOT` in the generator, both against
 * the two files by name.
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
