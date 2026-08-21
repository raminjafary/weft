import {
  BINARY_OPS,
  type BinaryOp,
  type DerivedDecl,
  type DerivedExpr,
  type EscapeClass,
  type Hole,
  type SignalDecl,
  type TemplateIR,
  UNARY_OPS,
  type UnaryOp,
  type WiringEntry,
} from '@weft/ir'
import {
  BOOLEAN_ATTRIBUTES,
  bindsToProperty,
  VOID_ELEMENTS,
  isSurviving,
  name,
  node,
  nodes,
  trimJsxText,
  type Node,
} from './ast.ts'
import { CompileError, locate } from './errors.ts'
import { intentId } from './intents.ts'
import { cannotBeMarkup, type TypeOracle } from './types.ts'

export interface ImportRef {
  /** The specifier exactly as written, which is what resolving a sibling module needs. */
  module: string
  exported: string
  /**
   * The module id: project-relative and slash-separated, the same form a template id uses.
   *
   * An intent id is derived from where the intent lives, and a relative specifier is not where
   * it lives — it is where the *importer* is standing. Two fragments at different depths
   * importing one intent wrote `../intents/cart.ts` and `../../intents/cart.ts` and got two
   * different ids for one export, neither of which a build's manifest could match. This is the
   * answer to "which module", asked once, at the only place that knows both paths.
   */
  id: string
}

export interface Scope {
  props: Set<string>
  propsIdent?: string
  signals: Map<string, SignalDecl>
  imports: Map<string, ImportRef>
  /** Values computed in the fragment body, including everything read through the context. */
  locals: Set<string>
  /** The context parameter, whose calls are the fragment's reads. */
  ctxParam?: string
  /** Set inside a list row: the map callback's parameter name. */
  itemParam?: string
  /** Fragments this one may render, by the name it refers to them as. */
  components?: Map<string, ComponentRef>
  /**
   * Set when some fragment in this module renders this one. A component's props are the
   * only bindings a caller can hand a signal to, so they are wired; a template nobody
   * composes carries no wiring it will never use. The client skips a wiring entry with no
   * source, so a caller that passes a plain value costs nothing.
   */
  wireProps?: boolean
}

/**
 * A template the parent renders. A child in the same module arrives as a lowering the
 * parent seals on its way out; one from another module has already been sealed by its own
 * compilation, and the parent only names the version.
 */
export interface NestedRequest {
  holeIndex: number
  id: string
  lowered?: Lowered
  sealed?: SealedFragment
}

/** A fragment another module already compiled: its entry, and everything it needs. */
export interface SealedFragment {
  entry: TemplateIR
  templates: TemplateIR[]
}

/**
 * A fragment another fragment can render. `props` is the set the child declares, so a use
 * site can be checked against it rather than discovering a missing prop at render.
 */
export interface ComponentRef {
  id: string
  props: Set<string>
  lower?(): Lowered
  /** Set when the fragment was compiled by another module and is already sealed. */
  sealed?: SealedFragment
}

export interface Lowered {
  id: string
  parts: string[]
  holes: Hole[]
  wiring: WiringEntry[]
  signals: SignalDecl[]
  derived: DerivedDecl[]
  nested: NestedRequest[]
  markers: number
  /** Ids of the fragments this one renders, so a caller can union their effects. */
  components: string[]
}

interface Emitter {
  parts: string[]
  buffer: string
  holes: Hole[]
  wiring: WiringEntry[]
  nested: NestedRequest[]
  markers: number
  derived: DerivedDecl[]
  components: string[]
}

function escapeStatic(text: string, attr: boolean): string {
  let out = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  if (attr) out = out.replace(/"/g, '&quot;')
  return out
}

interface Classified {
  binding: string
  escape: EscapeClass
  provenance?: string
  /** Set when the value can change on the client, which is the only reason to wire it. */
  signal?: SignalDecl
  /** Set when the expression folds to a constant the compiler can put in a segment. */
  constant?: string
  /** Set when a derived expression reads a signal, so its hole has to be wired. */
  reactive?: boolean
  /** The bindings a derived expression reads, for deciding whether a prop drives it. */
  reads?: string[]
}

export interface LowerInput {
  id: string
  root: Node
  scope: Scope
  file: string
  source: string
  /** When present, escaping is decided by the value's type rather than by its syntax. */
  types?: TypeOracle
}

export function lower(input: LowerInput): Lowered {
  const em: Emitter = {
    parts: [],
    buffer: '',
    holes: [],
    wiring: [],
    nested: [],
    markers: 0,
    derived: [],
    components: [],
  }
  const root = input.root
  if (root.type === 'JSXFragment') {
    lowerChildren(nodes(root.children), [], em, input, '')
  } else if (root.type === 'JSXElement') {
    // A template always addresses from a container whose element children are its
    // top-level nodes, so a single root element is at [0] exactly as it would be inside
    // a fragment. Without this, [] would mean the root element in one case and the
    // container in the other.
    lowerElement(root, [0], em, input)
  } else {
    throw fail(input, root, 'E_ROOT_NOT_JSX', `a fragment must return JSX, found ${root.type}`)
  }
  em.parts.push(em.buffer)
  return {
    id: input.id,
    parts: em.parts,
    holes: em.holes,
    wiring: em.wiring,
    signals: [...input.scope.signals.values()],
    derived: em.derived,
    nested: em.nested,
    markers: em.markers,
    components: em.components,
  }
}

function fail(input: LowerInput, at: Node, code: string, message: string): CompileError {
  return new CompileError(code, message, locate(input.file, input.source, at.start ?? 0))
}

function emit(em: Emitter, value: string): void {
  em.buffer += value
}

function hole(em: Emitter, spec: Omit<Hole, 'index'>): number {
  em.parts.push(em.buffer)
  em.buffer = ''
  const index = em.holes.length
  em.holes.push({ ...spec, index })
  return index
}

function source(input: LowerInput, at: Node): string {
  return input.source.slice(at.start ?? 0, at.end ?? 0)
}

function classify(expr: Node, input: LowerInput, em: Emitter): Classified {
  return withTypeInformation(expr, input, classifyBySyntax(expr, input, em))
}

/**
 * Syntax can only prove a value safe in a handful of shapes. A type says so for any
 * expression, which is where the elided escaping the syntax pass gives up comes back.
 */
function withTypeInformation(expr: Node, input: LowerInput, classified: Classified): Classified {
  if (!input.types) return classified
  if (classified.escape !== 'escape' || classified.constant !== undefined) return classified
  const kind = input.types.kindAt(input.file, expr.start ?? -1, expr.end ?? -1)
  return cannotBeMarkup(kind) ? { ...classified, escape: 'proven-safe' } : classified
}

function classifyBySyntax(expr: Node, input: LowerInput, em: Emitter): Classified {
  const scope = input.scope

  if (expr.type === 'Literal') {
    const value = expr.value
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return { binding: '', escape: 'proven-safe', constant: String(value) }
    }
  }

  if (expr.type === 'Identifier') {
    const ident = name(expr)
    if (scope.signals.has(ident)) {
      throw fail(input, expr, 'E_SIGNAL_NOT_READ', `${ident} is a signal — read it as ${ident}()`)
    }
    if (scope.itemParam && ident === scope.itemParam) {
      throw fail(
        input,
        expr,
        'E_ITEM_NOT_A_VALUE',
        `${ident} is the row itself; interpolate one of its fields`,
      )
    }
    if (scope.itemParam) throw outOfRowScope(input, expr, ident)
    if (!scope.props.has(ident) && !scope.locals.has(ident)) {
      throw fail(
        input,
        expr,
        'E_UNKNOWN_BINDING',
        `${ident} is neither a prop of this fragment nor a value computed in its body`,
      )
    }
    return { binding: ident, escape: 'escape' }
  }

  if (expr.type === 'MemberExpression') {
    const object = node(expr.object)
    const property = node(expr.property)
    if (expr.computed) throw fail(input, expr, 'E_COMPUTED_MEMBER', 'computed member access is not supported')
    if (object.type === 'Identifier') {
      const owner = name(object)
      if (scope.itemParam && owner === scope.itemParam) return { binding: name(property), escape: 'escape' }
      if (scope.propsIdent && owner === scope.propsIdent) return { binding: name(property), escape: 'escape' }
      if (owner === scope.ctxParam) {
        throw fail(
          input,
          expr,
          'E_CTX_IN_MARKUP',
          `read ${owner}.${name(property)} into a value in the fragment body, so the compiler can record what it taints`,
        )
      }
      if (scope.itemParam) throw outOfRowScope(input, expr, owner)
    }
    throw fail(input, expr, 'E_EXPRESSION_UNSUPPORTED', `cannot resolve ${source(input, expr)} to a binding`)
  }

  if (expr.type === 'CallExpression') {
    const callee = node(expr.callee)
    if (callee.type === 'MemberExpression' && !callee.computed) {
      const owner = node(callee.object)
      if (owner.type === 'Identifier' && name(owner) === scope.ctxParam) {
        throw fail(
          input,
          expr,
          'E_CTX_IN_MARKUP',
          `read ${name(owner)}.${name(node(callee.property))}() into a value in the fragment body, so the compiler can record what it taints`,
        )
      }
    }
    if (callee.type === 'Identifier') {
      const called = name(callee)
      const signal = scope.signals.get(called)
      if (signal) {
        if (scope.itemParam) {
          throw fail(
            input,
            expr,
            'E_SIGNAL_IN_LIST',
            `signal ${called} is read inside a list row; a row is its own template and cannot close over the outer scope`,
          )
        }
        const numeric = signal.type === 'number' || signal.type === 'boolean'
        return { binding: called, escape: numeric ? 'proven-safe' : 'escape', signal }
      }
      const imported = scope.imports.get(called)
      if (imported && imported.exported === 'raw' && imported.module === 'weft') {
        const argument = nodes(expr.arguments)[0]
        if (!argument) throw fail(input, expr, 'E_RAW_EMPTY', 'raw() needs an argument')
        const inner = classify(argument, input, em)
        return { ...inner, escape: 'trusted-raw', provenance: source(input, argument) }
      }
    }
    throw fail(input, expr, 'E_EXPRESSION_UNSUPPORTED', `cannot resolve ${source(input, expr)} to a binding`)
  }

  if (expr.type === 'UnaryExpression' || expr.type === 'BinaryExpression') {
    const safe = provablyNotMarkup(expr)
    const reads: SignalDecl[] = []
    const refs: string[] = []
    const tree = derivedExpr(expr, input, em, reads, refs)
    const id = `d${em.derived.length}`
    em.derived.push({ id, expr: tree })
    return {
      binding: id,
      escape: safe ? 'proven-safe' : 'escape',
      reads: refs,
      ...(reads.length ? { reactive: true } : {}),
    }
  }

  throw fail(input, expr, 'E_EXPRESSION_UNSUPPORTED', `${expr.type} is not supported in a template`)
}

function outOfRowScope(input: LowerInput, at: Node, ident: string): CompileError {
  return fail(
    input,
    at,
    'E_OUT_OF_ROW_SCOPE',
    `${ident} comes from outside this list row; a row is its own template and receives only its item`,
  )
}

/**
 * Whether the client has to be able to write this hole. A signal read always; a prop of a
 * fragment somebody composes, because a caller may hand it one.
 */
function isReactive(classified: Classified, input: LowerInput): boolean {
  if (classified.signal !== undefined || classified.reactive === true) return true
  if (!input.scope.wireProps) return false
  const ids = classified.reads ?? [classified.binding]
  return ids.some((id) => input.scope.props.has(id))
}

/** Arithmetic and comparison cannot produce markup; `+` and logical operators can. */
function provablyNotMarkup(expr: Node): boolean {
  if (expr.type === 'UnaryExpression') return ['!', '-', '+', '~'].includes(String(expr.operator))
  const operator = String(expr.operator)
  return ['-', '*', '/', '%', '**', '<', '>', '<=', '>=', '===', '!==', '==', '!='].includes(operator)
}

/**
 * Turns an arithmetic or comparison expression into the encoded tree the IR carries, so
 * the client can evaluate the same expression the server did without being shipped code.
 * Leaves go back through the same classifier every other interpolation uses, which is
 * what keeps scope rules — row scope, context reads, unknown bindings — in one place.
 */
function derivedExpr(
  expr: Node,
  input: LowerInput,
  em: Emitter,
  reads: SignalDecl[],
  refs: string[],
): DerivedExpr {
  if (expr.type === 'UnaryExpression') {
    const op = String(expr.operator)
    if (!UNARY_OPS.includes(op as UnaryOp)) {
      throw fail(input, expr, 'E_OPERATOR_UNSUPPORTED', `unary ${op} cannot be evaluated on the client`)
    }
    return { k: 'un', op: op as UnaryOp, a: derivedExpr(node(expr.argument), input, em, reads, refs) }
  }

  if (expr.type === 'BinaryExpression') {
    const op = String(expr.operator)
    if (!BINARY_OPS.includes(op as BinaryOp)) {
      throw fail(input, expr, 'E_OPERATOR_UNSUPPORTED', `binary ${op} cannot be evaluated on the client`)
    }
    return {
      k: 'bin',
      op: op as BinaryOp,
      a: derivedExpr(node(expr.left), input, em, reads, refs),
      b: derivedExpr(node(expr.right), input, em, reads, refs),
    }
  }

  const leaf = classifyBySyntax(expr, input, em)
  if (leaf.constant !== undefined) return { k: 'lit', v: literal(expr, leaf.constant) }
  if (leaf.signal) reads.push(leaf.signal)
  refs.push(leaf.binding)
  return { k: 'ref', id: leaf.binding }
}

/** A folded leaf keeps the type it was written with; only its string form was folded. */
function literal(expr: Node, folded: string): string | number | boolean {
  const value = expr.type === 'Literal' ? expr.value : undefined
  if (typeof value === 'number' || typeof value === 'boolean') return value
  return folded
}

function mapCall(expr: Node): { array: Node; callback: Node } | null {
  if (expr.type !== 'CallExpression') return null
  const callee = node(expr.callee)
  if (callee.type !== 'MemberExpression' || callee.computed) return null
  if (name(node(callee.property)) !== 'map') return null
  const callback = nodes(expr.arguments)[0]
  if (!callback || (callback.type !== 'ArrowFunctionExpression' && callback.type !== 'FunctionExpression'))
    return null
  return { array: node(callee.object), callback }
}

function lowerElement(element: Node, path: number[], em: Emitter, input: LowerInput): void {
  const opening = node(element.openingElement)
  const tag = name(node(opening.name))
  if (!/^[a-z][a-z0-9-]*$/.test(tag)) {
    lowerComponent(element, tag, path, em, input)
    return
  }

  emit(em, `<${tag}`)
  for (const raw of nodes(opening.attributes)) lowerAttribute(raw, path, em, input, tag)
  emit(em, '>')

  if (VOID_ELEMENTS.has(tag)) {
    if (nodes(element.children).filter(isSurviving).length) {
      throw fail(input, element, 'E_VOID_CHILDREN', `<${tag}> is a void element and cannot have children`)
    }
    return
  }

  lowerChildren(nodes(element.children), path, em, input, tag)
  emit(em, `</${tag}>`)
}

/**
 * A component instance is a nested template plus a projection: child prop name to the
 * parent binding that supplies it. Nothing about the child is inlined, so one `<Widget/>`
 * used five times is one sealed template used five times, and the instance occupies
 * exactly one element position in the parent — which is why the child must have a single
 * root, the same rule a list row already lives under.
 */
function lowerComponent(element: Node, tag: string, path: number[], em: Emitter, input: LowerInput): void {
  const ref = input.scope.components?.get(tag)
  if (!ref) {
    throw fail(
      input,
      element,
      'E_COMPONENT_UNRESOLVED',
      `<${tag}> is not a fragment declared in this module; composition across modules needs a build graph that does not exist yet`,
    )
  }
  if (input.scope.itemParam) {
    throw fail(
      input,
      element,
      'E_COMPONENT_IN_LIST',
      `<${tag}> is rendered inside a list row; a row is its own template and cannot carry an instance`,
    )
  }
  if (nodes(element.children).filter(isSurviving).length) {
    throw fail(
      input,
      element,
      'E_COMPONENT_CHILDREN_UNSUPPORTED',
      `<${tag}> is given children; a component takes props only until slots are built`,
    )
  }

  const props: Record<string, string> = {}
  for (const raw of nodes(node(element.openingElement).attributes)) {
    const attribute = node(raw)
    if (attribute.type === 'JSXSpreadAttribute') {
      throw fail(input, attribute, 'E_SPREAD_UNSUPPORTED', 'spread attributes hide what a component receives')
    }
    const prop = name(node(attribute.name))
    if (prop === 'key') continue
    if (/^on[A-Z]/.test(prop)) {
      throw fail(
        input,
        attribute,
        'E_COMPONENT_EVENT_UNSUPPORTED',
        `${prop} is an event on <${tag}>; an intent binds to an element, and the component owns its own`,
      )
    }
    if (!ref.props.has(prop)) {
      throw fail(input, attribute, 'E_COMPONENT_PROP_UNKNOWN', `${tag} does not declare a prop named ${prop}`)
    }
    props[prop] = componentProp(attribute, prop, tag, em, input)
  }

  for (const declared of ref.props) {
    if (!(declared in props)) {
      throw fail(
        input,
        element,
        'E_COMPONENT_PROP_MISSING',
        `${tag} declares a prop named ${declared} and this use site does not supply it`,
      )
    }
  }

  const child = ref.sealed?.entry ?? ref.lower?.()
  if (!child) throw fail(input, element, 'E_COMPONENT_UNRESOLVED', `<${tag}> resolved to nothing`)
  if (child.holes.some((h) => h.path.length === 0)) {
    throw fail(input, element, 'E_COMPONENT_NOT_SINGLE_ROOT', `<${tag}> must render a single root element`)
  }

  const holeIndex = hole(em, {
    kind: 'component',
    escape: 'trusted-raw',
    binding: `c${em.components.length}`,
    path,
    props,
    provenance: ref.id,
  })
  em.components.push(ref.id)
  em.nested.push({
    holeIndex,
    id: ref.id,
    ...(ref.sealed ? { sealed: ref.sealed } : { lowered: child as Lowered }),
  })
}

/**
 * One prop. A literal folds into the derived table as a constant rather than becoming a
 * value the caller has to supply, so `<Badge tone="warn"/>` needs nothing at render.
 */
function componentProp(attribute: Node, prop: string, tag: string, em: Emitter, input: LowerInput): string {
  const value = attribute.value === null || attribute.value === undefined ? null : node(attribute.value)
  if (value === null) {
    const id = `d${em.derived.length}`
    em.derived.push({ id, expr: { k: 'lit', v: true } })
    return id
  }
  if (value.type === 'Literal') {
    const id = `d${em.derived.length}`
    em.derived.push({ id, expr: { k: 'lit', v: (value.value ?? null) as never } })
    return id
  }
  if (value.type !== 'JSXExpressionContainer') {
    throw fail(input, value, 'E_ATTRIBUTE_UNSUPPORTED', `prop ${prop} of <${tag}> has an unsupported value`)
  }

  const classified = classify(node(value.expression), input, em)
  if (classified.constant !== undefined) {
    const id = `d${em.derived.length}`
    em.derived.push({ id, expr: { k: 'lit', v: classified.constant } })
    return id
  }
  return classified.binding
}

function lowerAttribute(attribute: Node, path: number[], em: Emitter, input: LowerInput, tag: string): void {
  if (attribute.type === 'JSXSpreadAttribute') {
    throw fail(
      input,
      attribute,
      'E_SPREAD_UNSUPPORTED',
      'spread attributes hide what the template can contain',
    )
  }
  const attr = name(node(attribute.name))
  if (attr === 'key') return

  const value = attribute.value === null || attribute.value === undefined ? null : node(attribute.value)

  if (value === null) {
    emit(em, ` ${attr}`)
    return
  }

  if (value.type === 'Literal') {
    emit(em, ` ${attr}="${escapeStatic(String(value.value ?? ''), true)}"`)
    return
  }

  if (value.type !== 'JSXExpressionContainer') {
    throw fail(input, value, 'E_ATTRIBUTE_UNSUPPORTED', `attribute ${attr} has an unsupported value`)
  }

  const expression = node(value.expression)

  if (/^on[A-Z]/.test(attr)) {
    lowerEvent(attr, expression, path, em, input)
    return
  }

  const classified = classify(expression, input, em)

  if (classified.constant !== undefined) {
    const folded =
      classified.escape === 'trusted-raw' ? classified.constant : escapeStatic(classified.constant, true)
    emit(em, ` ${attr}="${folded}"`)
    return
  }

  // The server still renders the attribute — it is what the parser builds the control
  // from. Only the client's write goes to the property.
  const op = bindsToProperty(tag, attr) ? 'prop' : undefined

  if (BOOLEAN_ATTRIBUTES.has(attr)) {
    emit(em, ' ')
    hole(em, { kind: 'attr-bool', escape: 'proven-safe', binding: classified.binding, path, attr })
    if (isReactive(classified, input)) {
      em.wiring.push({ path, op: op ?? 'bool', binding: classified.binding, attr })
    }
    return
  }

  emit(em, ` ${attr}="`)
  hole(em, {
    kind: 'attr',
    escape: classified.escape,
    binding: classified.binding,
    path,
    attr,
    ...(classified.provenance ? { provenance: classified.provenance } : {}),
  })
  emit(em, '"')
  if (isReactive(classified, input)) {
    em.wiring.push({ path, op: op ?? 'attr', binding: classified.binding, attr })
  }
}

function lowerEvent(attr: string, expression: Node, path: number[], em: Emitter, input: LowerInput): void {
  const event = attr.slice(2).toLowerCase()
  if (expression.type !== 'Identifier') {
    throw fail(
      input,
      expression,
      'E_HANDLER_NOT_AN_INTENT',
      `${attr} must reference an imported intent, so the client names an id rather than server code`,
    )
  }
  const local = name(expression)
  const imported = input.scope.imports.get(local)
  if (!imported) {
    throw fail(
      input,
      expression,
      'E_HANDLER_NOT_IMPORTED',
      `${local} is not imported, so it has no stable intent id`,
    )
  }
  em.wiring.push({
    path,
    op: 'event',
    binding: '',
    event,
    intent: intentId(imported.id, imported.exported),
  })
}

function lowerChildren(
  children: Node[],
  path: number[],
  em: Emitter,
  input: LowerInput,
  parentTag: string,
): void {
  const surviving = children.filter(isSurviving)
  let elementIndex = 0

  surviving.forEach((child, i) => {
    if (child.type === 'JSXText') {
      emit(em, escapeStatic(trimJsxText(String(child.value ?? '')), false))
      return
    }

    if (child.type === 'JSXElement' || child.type === 'JSXFragment') {
      if (child.type === 'JSXFragment') {
        throw fail(input, child, 'E_NESTED_FRAGMENT', 'a fragment may only appear at the root of a template')
      }
      lowerElement(child, [...path, elementIndex++], em, input)
      return
    }

    const expression = node(child.expression)
    const list = mapCall(expression)

    if (list) {
      if (surviving.length !== 1) {
        throw fail(
          input,
          child,
          'E_LIST_NOT_SOLE_CHILD',
          'a list must be the only child of its element, so that sibling positions cannot shift with the row count',
        )
      }
      lowerList(list, path, em, input)
      return
    }

    const classified = classify(expression, input, em)

    if (classified.constant !== undefined) {
      emit(
        em,
        classified.escape === 'trusted-raw' ? classified.constant : escapeStatic(classified.constant, false),
      )
      return
    }

    // Inside <slot>, a dynamic child is the streaming hole itself: the base render
    // emits nothing and a later frame fills it.
    if (parentTag === 'slot') {
      hole(em, { kind: 'slot', escape: 'proven-safe', binding: classified.binding, path })
      return
    }

    const sole = surviving.length === 1
    let anchor: number | undefined
    if (!sole) {
      emit(em, '<!>')
      anchor = em.markers++
    }

    hole(em, {
      kind: 'text',
      escape: classified.escape,
      binding: classified.binding,
      path,
      ...(classified.provenance ? { provenance: classified.provenance } : {}),
      ...(anchor !== undefined ? { anchor } : {}),
    })

    const next = surviving[i + 1]
    if (!sole && next && next.type === 'JSXText') {
      emit(em, '<!>')
      em.markers++
    }

    if (isReactive(classified, input)) {
      em.wiring.push({
        path,
        op: 'text',
        binding: classified.binding,
        ...(anchor !== undefined ? { anchor } : {}),
      })
    }
  })
}

function lowerList(
  list: { array: Node; callback: Node },
  path: number[],
  em: Emitter,
  input: LowerInput,
): void {
  const arrayBinding = classify(list.array, input, em)
  const param = nodes(list.callback.params)[0]
  if (!param || param.type !== 'Identifier') {
    throw fail(input, list.callback, 'E_MAP_PARAM', 'the row callback needs a single named parameter')
  }

  const body = node(list.callback.body)
  const rowRoot = body.type === 'BlockStatement' ? returnedJsx(body, input) : body
  if (rowRoot.type === 'JSXFragment') {
    throw fail(
      input,
      rowRoot,
      'E_ROW_NOT_SINGLE_ROOT',
      "a row must be a single element, otherwise the parent's children cannot be divided into rows",
    )
  }
  const id = `${input.id}:${arrayBinding.binding}[]`

  const lowered = lower({
    id,
    root: rowRoot,
    file: input.file,
    source: input.source,
    ...(input.types ? { types: input.types } : {}),
    scope: { ...input.scope, itemParam: name(param), signals: input.scope.signals, locals: new Set() },
  })

  const holeIndex = hole(em, {
    kind: 'list',
    escape: 'trusted-raw',
    binding: arrayBinding.binding,
    path,
    provenance: id,
  })
  em.nested.push({ holeIndex, id, lowered })
}

export function returnedJsx(block: Node, input: LowerInput): Node {
  for (const statement of nodes(block.body)) {
    if (statement.type === 'ReturnStatement') return node(statement.argument)
  }
  throw fail(input, block, 'E_NO_RETURN', 'a fragment body must return JSX')
}
