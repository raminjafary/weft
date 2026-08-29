import { resolveDerived } from './derived.ts'
import { isTruthy, render, renderSubtree, valueText } from './render.ts'
import { rawValue } from './template-ir.ts'
import type { Hole, Json, TemplateIR, Values } from './template-ir.ts'
import { PAYLOAD_SPEC, PAYLOAD_VERSION } from './version.ts'

const decoder = new TextDecoder()

/** The rung between `delta` and `html`, and the one the ladder was missing. See `spec/kernel/surgical.md`. */
export type PatchOp =
  /** Write text into a text node: `.data`, so what travels is unescaped. */
  | 'text'
  /** Replace an element's children with parsed markup: a raw value, or a call site's children. */
  | 'markup'
  /** Replace the element itself: a component instance, or one row of a list. */
  | 'replace'
  /** Add rows to the end of a list. */
  | 'append'
  /** Drop the rows past `value` from a list. */
  | 'truncate'
  | 'attr'
  | 'bool'
  | 'presence'

/** One hole's markup, addressed by path — the rung that needs no resident template. */
export interface PatchWrite {
  /** Element children only, from the region root — the address adoption already walks. */
  path: number[]
  op: PatchOp
  attr?: string
  /** Marker ordinal, for a text hole that is not the only child of its element. */
  anchor?: number
  /** Absent means remove: a boolean that went false, or a presence attribute with no value. */
  value?: string
}

/** A patch: the markup of the holes that changed, and nothing about the ones that did not. */
export interface PatchPayload {
  spec: typeof PAYLOAD_SPEC
  irVersion: string
  form: 'patch'
  tpl: string
  base: string
  /** Paths of the holes whose subtree owns its own markers, so a client with no template arrives at the same ordinals. */
  opaque: number[][]
  writes: PatchWrite[]
}

/** Which holes a patch never addresses, because their bytes are not this render's. */
function foreign(hole: Hole): boolean {
  return hole.kind === 'slot' || Boolean(hole.isolated)
}

function opaquePaths(ir: TemplateIR): number[][] {
  const out: number[][] = []
  for (const hole of ir.holes) {
    if (hole.kind === 'list' || hole.kind === 'component' || hole.kind === 'children') out.push(hole.path)
  }
  return out
}

/** What changed between two renders of one template, as writes into the DOM the first one produced. */
export function patchPayload(
  ir: TemplateIR,
  base: string,
  prev: Values,
  next: Values,
  resolve?: (version: string) => TemplateIR | undefined,
): PatchPayload {
  const before = resolveDerived(ir.derived, prev)
  const after = resolveDerived(ir.derived, next)
  const writes: PatchWrite[] = []

  ir.holes.forEach((hole, index) => {
    if (foreign(hole)) return

    if (hole.kind === 'list') {
      writes.push(...rows(hole, before[hole.binding], after[hole.binding], resolve))
      return
    }

    if (hole.kind === 'component' || hole.kind === 'children') {
      const was = renderSubtree(ir, index, prev, resolve)
      const now = renderSubtree(ir, index, next, resolve)
      if (same(was, now)) return
      writes.push({
        path: hole.path,
        op: hole.kind === 'component' ? 'replace' : 'markup',
        value: decoder.decode(now),
      })
      return
    }

    const was = before[hole.binding]
    const now = after[hole.binding]

    if (hole.kind === 'attr-bool') {
      if (isTruthy(was) === isTruthy(now)) return
      writes.push({
        path: hole.path,
        op: 'bool',
        ...(hole.attr ? { attr: hole.attr } : {}),
        ...(isTruthy(now) ? { value: '' } : {}),
      })
      return
    }

    if (hole.kind === 'attr-presence') {
      const wasText = isTruthy(was) ? valueText(was) : undefined
      const nowText = isTruthy(now) ? valueText(now) : undefined
      if (wasText === nowText) return
      writes.push({
        path: hole.path,
        op: 'presence',
        ...(hole.attr ? { attr: hole.attr } : {}),
        ...(nowText === undefined ? {} : { value: nowText }),
      })
      return
    }

    const wasText = valueText(was)
    const nowText = valueText(now)
    if (wasText === nowText) return

    if (hole.kind === 'attr') {
      writes.push({
        path: hole.path,
        op: 'attr',
        ...(hole.attr ? { attr: hole.attr } : {}),
        value: nowText,
      })
      return
    }

    // Reaching here for an unaddressable raw value means a document declared a form `derivableForms` should have refused.
    if (rawValue(hole)) {
      if (hole.anchor !== undefined) {
        throw new Error(
          `E_PATCH_UNADDRESSABLE: hole ${hole.index} is raw markup after marker ${hole.anchor} and has no boundary this patch can address`,
        )
      }
      writes.push({ path: hole.path, op: 'markup', value: nowText })
      return
    }

    writes.push({
      path: hole.path,
      op: 'text',
      ...(hole.anchor !== undefined ? { anchor: hole.anchor } : {}),
      value: nowText,
    })
  })

  return {
    spec: PAYLOAD_SPEC,
    irVersion: PAYLOAD_VERSION,
    form: 'patch',
    tpl: ir.version,
    base,
    opaque: opaquePaths(ir),
    writes,
  }
}

/** A list, row by row rather than host and all. See `spec/kernel/surgical.md` for the measurement that killed the host-replace version. */
function rows(
  hole: Hole,
  was: Json | undefined,
  now: Json | undefined,
  resolve: ((version: string) => TemplateIR | undefined) | undefined,
): PatchWrite[] {
  const row = hole.nested ? resolve?.(hole.nested) : undefined
  if (!Array.isArray(was) || !Array.isArray(now) || !row) {
    // A list of plain values, or a row template nothing can resolve: the host's content is the
    // only boundary there is.
    const markup = renderList(hole, now, resolve)
    return markup === renderList(hole, was, resolve) ? [] : [{ path: hole.path, op: 'markup', value: markup }]
  }

  const out: PatchWrite[] = []
  const common = Math.min(was.length, now.length)
  for (let i = 0; i < common; i++) {
    const before = render(row, was[i] as Values, resolve)
    const after = render(row, now[i] as Values, resolve)
    if (same(before, after)) continue
    out.push({ path: [...hole.path, i], op: 'replace', value: decoder.decode(after) })
  }
  if (now.length > common) {
    const added = now
      .slice(common)
      .map((item) => decoder.decode(render(row, item as Values, resolve)))
      .join('')
    out.push({ path: hole.path, op: 'append', value: added })
  }
  // Removal is a count rather than a list of positions: the rows that go are always the tail,
  // because everything before it was addressed above.
  if (was.length > common) out.push({ path: hole.path, op: 'truncate', value: String(now.length) })
  return out
}

function renderList(
  hole: Hole,
  value: Json | undefined,
  resolve: ((version: string) => TemplateIR | undefined) | undefined,
): string {
  const holder: Values = { [hole.binding]: value ?? null }
  return decoder.decode(
    renderSubtree({ holes: [hole], derived: [] } as unknown as TemplateIR, 0, holder, resolve),
  )
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}
