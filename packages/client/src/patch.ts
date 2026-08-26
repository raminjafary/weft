import { collectMarkers, elementAt, soleText, textAfter } from './adopt.ts'

/**
 * The `patch` form, applied.
 *
 * A delta needs the client's binding table, which means the template. A patch needs the DOM and
 * nothing else: every write carries its own address — an element path, and a marker ordinal for a
 * text node that is not its element's only child — so a region whose values are not projectable
 * still updates one node at a time instead of being replaced whole.
 *
 * Two consequences worth naming. Addresses are resolved before anything is written, because a
 * markup write moves the nodes a later address would have counted. And a patch is applied on
 * arrival or not at all: staging one would mean holding positions that another epoch's commit can
 * move, so a PATCH naming an epoch is refused rather than held. See `spec/kernel/surgical.md`.
 */
export type PatchOp = 'text' | 'markup' | 'replace' | 'append' | 'truncate' | 'attr' | 'bool' | 'presence'

/** One hole's new markup, addressed by path rather than by value. */
export interface PatchWrite {
  path: number[]
  op: PatchOp
  attr?: string
  anchor?: number
  value?: string
}

/** A patch: the markup of the holes that changed, for a client holding no template. */
export interface PatchPayload {
  tpl: string
  base: string
  /** Holes whose subtree owns its own markers, so this counts anchors the way adoption did. */
  opaque: number[][]
  writes: PatchWrite[]
}

type Resolved =
  | { kind: 'text'; node: Text; value: string }
  | { kind: 'markup'; element: Element; value: string }
  | { kind: 'replace'; element: Element; value: string }
  | { kind: 'append'; element: Element; value: string }
  | { kind: 'truncate'; element: Element; value: string }
  | { kind: 'attr'; element: Element; attr: string; value?: string }

/** Apply a patch and return how many holes it touched. The rung that needs nothing resident. */
export function applyPatch(root: Element, patch: PatchPayload): number {
  const opaque = new Set<Element>()
  for (const path of patch.opaque) {
    const element = elementAt(root, path, 'container')
    if (element) opaque.add(element)
  }
  const markers = collectMarkers(root, opaque)

  const resolved: Resolved[] = []
  for (const write of patch.writes) {
    const element = elementAt(root, write.path, 'container')
    if (!element) continue
    if (write.op === 'text') {
      const marker = write.anchor === undefined ? undefined : markers[write.anchor]
      if (write.anchor !== undefined && !marker) continue
      resolved.push({
        kind: 'text',
        node: marker ? textAfter(marker) : soleText(element),
        value: write.value ?? '',
      })
      continue
    }
    if (write.op === 'markup' || write.op === 'replace' || write.op === 'append' || write.op === 'truncate') {
      resolved.push({ kind: write.op, element, value: write.value ?? '' })
      continue
    }
    if (!write.attr) continue
    resolved.push({
      kind: 'attr',
      element,
      attr: write.attr,
      // A boolean that went false and a presence attribute with nothing to show both arrive
      // with no value, and both mean remove.
      ...(write.value === undefined ? {} : { value: write.value }),
    })
  }

  for (const write of resolved) {
    if (write.kind === 'text') write.node.data = write.value
    else if (write.kind === 'markup') write.element.innerHTML = write.value
    else if (write.kind === 'replace') write.element.replaceWith(...parse(write.element, write.value))
    else if (write.kind === 'append') write.element.append(...parse(write.element, write.value))
    else if (write.kind === 'truncate') {
      // What a list dropped is always its tail: every row before it was addressed by position.
      for (let n = write.element.children.length; n > Number(write.value); n--) {
        write.element.lastElementChild?.remove()
      }
    } else if (write.value === undefined) write.element.removeAttribute(write.attr)
    else write.element.setAttribute(write.attr, write.value)
  }
  return resolved.length
}

/**
 * Markup parsed in a context that accepts it. A `<template>` parses table rows and list items
 * that would be dropped as the child of a `<div>`, which is exactly the markup a row template
 * produces.
 */
function parse(near: Element, markup: string): Node[] {
  const host = near.ownerDocument.createElement('template')
  host.innerHTML = markup
  return Array.from(host.content.childNodes)
}

/** Whether a patch is addressed to the render this region is actually showing. */
export function patchApplies(held: string, patch: PatchPayload): boolean {
  return held === patch.base
}

/** Where a patch write lands, resolved against the live DOM. */
export interface PatchTarget {
  /** The region's root element, which is where every address in the patch starts. */
  root: Element
  /** The base this region is showing. A patch computed from another one is refused. */
  base: string
}

const decoder = new TextDecoder()

function header(
  frame: { header: Record<string, string | number | boolean> },
  key: string,
): string | undefined {
  const value = frame.header[key]
  return value === undefined ? undefined : String(value)
}

/**
 * The channel handler, registered through `onFrame` — the extension point a capability that owns
 * a frame kind uses, so a page that never receives a `PATCH` carries none of this.
 */
export function patchFrames(
  target: (slot: string) => PatchTarget | undefined,
  onPatched?: (slot: string, writes: number, next: string) => void,
): (
  frame: { kind: string; header: Record<string, string | number | boolean>; body?: Uint8Array },
  applied: { writes: number; refused: { slot: string; reason: string }[] },
) => void {
  return (frame, applied) => {
    if (frame.kind !== 'PATCH') return
    const slot = header(frame, 's') ?? ''
    const found = target(slot)
    if (!found) {
      applied.refused.push({ slot, reason: 'no such region on this client' })
      return
    }
    if (header(frame, 'epoch') !== undefined) {
      applied.refused.push({
        slot,
        reason: 'a patch addresses nodes by position and cannot be held for a commit',
      })
      return
    }
    const body = frame.body ? (JSON.parse(decoder.decode(frame.body)) as Partial<PatchPayload>) : {}
    const patch: PatchPayload = {
      tpl: header(frame, 'tpl') ?? '',
      base: header(frame, 'base') ?? '',
      opaque: body.opaque ?? [],
      writes: body.writes ?? [],
    }
    if (!patchApplies(found.base, patch)) {
      applied.refused.push({ slot, reason: `holds ${found.base}, patch is from ${patch.base}` })
      return
    }
    const writes = applyPatch(found.root, patch)
    applied.writes += writes
    const next = header(frame, 'next') ?? found.base
    found.base = next
    onPatched?.(slot, writes, next)
  }
}
