import type { ClientHole, ClientTemplate, Json, Resident } from './template.ts'
import type { Readable } from './signal.ts'
import { bindDerived } from './derived.ts'

export type Target =
  | { kind: 'text'; node: Text }
  | { kind: 'attr'; element: Element; attr: string }
  | { kind: 'bool'; element: Element; attr: string }

export interface Adopted {
  /** Writes a value into every node the server rendered it into. */
  write(binding: string, value: Json): void
  target(binding: string): Target | undefined
  /** One value can occupy several holes — a quantity is a field, a label, and a flag. */
  targets(binding: string): Target[]
  /** Per-row bindings for the template's list hole, in document order. */
  rows: Adopted[]
  /** Component instances, by the binding their hole carries. */
  instances: Record<string, Adopted>
  template: ClientTemplate
}

export interface AdoptOptions {
  root: Element
  template: ClientTemplate
  resident?: Resident
  signals?: Record<string, Readable<unknown>>
  onIntent?: (intent: string, event: Event) => void
  /**
   * `container` — `root`'s element children are the template's top-level nodes, which is
   * how a region is adopted. `element` — `root` *is* the template's single top-level
   * element, which is how one row of a list is adopted out of its parent's children.
   */
  origin?: 'container' | 'element'
}

/**
 * Adoption, which is the whole bet: no component code runs. One pass collects the marker
 * comments, element paths are followed by index, and the result is a table from binding
 * to the node that holds it. Cost is a function of the number of bindings, not of the
 * number of components, and none of it is repeated on a later visit if the template is
 * already resident.
 */
export function adopt(options: AdoptOptions): Adopted {
  const { root, template } = options
  const origin = options.origin ?? 'container'

  // A nested template owns its own markers and its own addressing, so the parent's walk
  // stops at the boundary. Without this a component's comments would shift every anchor
  // that follows it.
  const opaque = new Set<Element>()
  for (const hole of template.holes) {
    if (hole.kind !== 'list' && hole.kind !== 'component') continue
    const element = elementAt(root, hole.path, origin)
    if (element) opaque.add(element)
  }

  const markers = collectMarkers(root, opaque)
  const targets = new Map<string, Target[]>()
  const rows: Adopted[] = []
  const instances: Record<string, Adopted> = {}

  const record = (binding: string, target: Target): void => {
    const existing = targets.get(binding)
    if (existing) existing.push(target)
    else targets.set(binding, [target])
  }

  for (const hole of template.holes) {
    if (hole.kind === 'slot') continue

    if (hole.kind === 'list') {
      const host = elementAt(root, hole.path, origin)
      const nested = hole.nested ? options.resident?.[hole.nested] : undefined
      if (!host || !nested) continue
      for (const child of Array.from(host.children)) {
        rows.push(adopt({ ...options, root: child, template: nested, origin: 'element' }))
      }
      continue
    }

    if (hole.kind === 'component') {
      const host = elementAt(root, hole.path, origin)
      const nested = hole.nested ? options.resident?.[hole.nested] : undefined
      if (!host || !nested) continue
      // The instance renders one root element, so it is adopted exactly as a row is. What
      // crosses the boundary is renamed on the way: the parent's signal arrives under the
      // name the child declared it as. Its targets are deliberately not folded into the
      // parent's table — a delta addresses the instance by name, and merging them would
      // make one changed value two writes.
      const instance = adopt({
        ...options,
        root: host,
        template: nested,
        origin: 'element',
        ...(options.signals ? { signals: forProps(hole.props, options.signals) } : {}),
      })
      instances[hole.binding] = instance
      continue
    }

    const target = locate(root, hole, markers, origin)
    if (target) record(hole.binding, target)
  }

  const adopted: Adopted = {
    template,
    rows,
    instances,
    target: (binding) => targets.get(binding)?.[0],
    targets: (binding) => targets.get(binding) ?? [],
    write: (binding, value) => {
      for (const target of targets.get(binding) ?? []) writeTarget(target, value)
    },
  }

  wire(adopted, options, markers)
  return adopted
}

/**
 * A row is addressed relative to itself, so a single-element template's root is the row
 * element. Element children only: text nodes come and go with the values.
 */
function elementAt(root: Element, path: number[], origin: 'container' | 'element'): Element | undefined {
  // With `element` origin the leading index names the root itself, so it is consumed.
  const segments = origin === 'element' ? path.slice(1) : path
  let node: Element | undefined = root
  for (const index of segments) {
    node = node?.children[index]
    if (!node) return undefined
  }
  return node
}

/**
 * Marker comments in document order, skipping list-hole subtrees because each row is its
 * own template instance with its own markers.
 */
function collectMarkers(root: Element, listRoots: Set<Element>): Comment[] {
  const out: Comment[] = []
  const walker = root.ownerDocument.createTreeWalker(root, 128 /* SHOW_COMMENT */)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!withinList(node, root, listRoots)) out.push(node as Comment)
  }
  return out
}

/** The parent's signals, renamed to the props the child declared them as. */
function forProps(
  props: Record<string, string> | undefined,
  signals: Record<string, Readable<unknown>>,
): Record<string, Readable<unknown>> {
  const out: Record<string, Readable<unknown>> = {}
  for (const [prop, binding] of Object.entries(props ?? {})) {
    const source = signals[binding]
    if (source) out[prop] = source
  }
  return out
}

function withinList(node: Node, root: Element, listRoots: Set<Element>): boolean {
  for (let parent = node.parentNode; parent && parent !== root; parent = parent.parentNode) {
    if (listRoots.has(parent as Element)) return true
  }
  return false
}

function locate(
  root: Element,
  hole: ClientHole,
  markers: Comment[],
  origin: 'container' | 'element',
): Target | undefined {
  if (hole.kind === 'attr' || hole.kind === 'attr-presence') {
    const element = elementAt(root, hole.path, origin)
    return element && hole.attr ? { kind: 'attr', element, attr: hole.attr } : undefined
  }
  if (hole.kind === 'attr-bool') {
    const element = elementAt(root, hole.path, origin)
    return element && hole.attr ? { kind: 'bool', element, attr: hole.attr } : undefined
  }

  if (hole.anchor !== undefined) {
    const marker = markers[hole.anchor]
    if (!marker) return undefined
    return { kind: 'text', node: textAfter(marker) }
  }

  const element = elementAt(root, hole.path, origin)
  if (!element) return undefined
  return { kind: 'text', node: soleText(element) }
}

/** The value's own text node, created if the value rendered empty. */
function textAfter(marker: Comment): Text {
  const next = marker.nextSibling
  if (next && next.nodeType === 3) return next as Text
  const node = marker.ownerDocument.createTextNode('')
  marker.parentNode?.insertBefore(node, next)
  return node
}

function soleText(element: Element): Text {
  const first = element.firstChild
  if (first && first.nodeType === 3) return first as Text
  const node = element.ownerDocument.createTextNode('')
  element.insertBefore(node, first)
  return node
}

function writeTarget(target: Target, value: Json): void {
  if (target.kind === 'text') {
    target.node.data = text(value)
    return
  }
  if (target.kind === 'bool') {
    if (truthy(value)) target.element.setAttribute(target.attr, '')
    else target.element.removeAttribute(target.attr)
    return
  }
  target.element.setAttribute(target.attr, text(value))
}

function wire(adopted: Adopted, options: AdoptOptions, markers: Comment[]): void {
  // A derived value is a binding like any other by the time wiring resolves it; what
  // makes it derived is that its readable was built from the wire, not handed in.
  const sources = bindDerived(options.template.derived, options.signals)

  for (const entry of options.template.wiring) {
    if (entry.op === 'event') {
      if (!entry.event || !entry.intent) continue
      const element = elementAt(options.root, entry.path, options.origin ?? 'container')
      const intent = entry.intent
      if (!element) continue
      element.addEventListener(entry.event, (event) => options.onIntent?.(intent, event))
      continue
    }

    const source = sources[entry.binding]
    if (!source) continue
    // Each wiring entry carries its own address: one signal bound three times is three
    // subscriptions, not one shared target.
    const target = locate(
      options.root,
      {
        index: -1,
        kind: opKind(entry.op),
        binding: entry.binding,
        path: entry.path,
        ...(entry.attr ? { attr: entry.attr } : {}),
        ...(entry.anchor !== undefined ? { anchor: entry.anchor } : {}),
      },
      markers,
      options.origin ?? 'container',
    )
    if (!target) continue
    source.subscribe(() => writeTarget(target, source() as Json))
  }
}

function opKind(op: string): ClientHole['kind'] {
  if (op === 'attr' || op === 'prop') return 'attr'
  if (op === 'bool') return 'attr-bool'
  return 'text'
}

function text(value: Json): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'string' ? value : String(value)
}

function truthy(value: Json): boolean {
  return value !== null && value !== undefined && value !== false && value !== '' && value !== 0
}
