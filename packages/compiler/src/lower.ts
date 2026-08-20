import type { EscapeClass, Hole, SignalDecl, WiringEntry } from '../../ir/src/index.ts'
import { BOOLEAN_ATTRIBUTES, VOID_ELEMENTS, isSurviving, name, node, nodes, trimJsxText, type Node } from './ast.ts'
import { CompileError, locate } from './errors.ts'
import { intentId } from './intents.ts'

export interface ImportRef {
  module: string
  exported: string
}

export interface Scope {
  props: Set<string>
  propsIdent?: string
  signals: Map<string, SignalDecl>
  imports: Map<string, ImportRef>
  /** Set inside a list row: the map callback's parameter name. */
  itemParam?: string
}

export interface NestedRequest {
  holeIndex: number
  id: string
  lowered: Lowered
}

export interface Lowered {
  id: string
  parts: string[]
  holes: Hole[]
  wiring: WiringEntry[]
  signals: SignalDecl[]
  nested: NestedRequest[]
  markers: number
}

interface Emitter {
  parts: string[]
  buffer: string
  holes: Hole[]
  wiring: WiringEntry[]
  nested: NestedRequest[]
  markers: number
  derived: number
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
}

export interface LowerInput {
  id: string
  root: Node
  scope: Scope
  file: string
  source: string
}

export function lower(input: LowerInput): Lowered {
  const em: Emitter = { parts: [], buffer: '', holes: [], wiring: [], nested: [], markers: 0, derived: 0 }
  const root = input.root
  if (root.type === 'JSXFragment') {
    lowerChildren(nodes(root.children), [], em, input, '')
  } else if (root.type === 'JSXElement') {
    lowerElement(root, [], em, input)
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
    nested: em.nested,
    markers: em.markers,
  }
}

function fail(input: LowerInput, at: Node, code: string, message: string): CompileError {
  return new CompileError(code, message, locate(input.file, input.source, at.start ?? 0))
}

function text(em: Emitter, value: string): void {
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
      throw fail(input, expr, 'E_ITEM_NOT_A_VALUE', `${ident} is the row itself; interpolate one of its fields`)
    }
    if (scope.itemParam) throw outOfRowScope(input, expr, ident)
    if (!scope.props.has(ident)) {
      throw fail(input, expr, 'E_UNKNOWN_BINDING', `${ident} is not a prop of this fragment`)
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
      if (scope.itemParam) throw outOfRowScope(input, expr, owner)
    }
    throw fail(input, expr, 'E_EXPRESSION_UNSUPPORTED', `cannot resolve ${source(input, expr)} to a binding`)
  }

  if (expr.type === 'CallExpression') {
    const callee = node(expr.callee)
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
    dependsOnNoSignal(expr, input)
    return { binding: `d${em.derived++}`, escape: safe ? 'proven-safe' : 'escape' }
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

/** Arithmetic and comparison cannot produce markup; `+` and logical operators can. */
function provablyNotMarkup(expr: Node): boolean {
  if (expr.type === 'UnaryExpression') return ['!', '-', '+', '~'].includes(String(expr.operator))
  const operator = String(expr.operator)
  return ['-', '*', '/', '%', '**', '<', '>', '<=', '>=', '===', '!==', '==', '!='].includes(operator)
}

function dependsOnNoSignal(expr: Node, input: LowerInput): void {
  const stack: Node[] = [expr]
  while (stack.length) {
    const current = stack.pop() as Node
    if (current.type === 'CallExpression') {
      const callee = node(current.callee)
      if (callee.type === 'Identifier' && input.scope.signals.has(name(callee))) {
        throw fail(
          input,
          current,
          'E_DERIVED_SIGNAL_UNSUPPORTED',
          `${name(callee)}() appears inside a computed expression; the prototype wires direct signal reads only`,
        )
      }
    }
    for (const value of Object.values(current)) {
      if (Array.isArray(value)) {
        for (const item of value) if (item && typeof item === 'object') stack.push(node(item))
      } else if (value && typeof value === 'object' && 'type' in (value as Node)) {
        stack.push(node(value))
      }
    }
  }
}

function mapCall(expr: Node): { array: Node; callback: Node } | null {
  if (expr.type !== 'CallExpression') return null
  const callee = node(expr.callee)
  if (callee.type !== 'MemberExpression' || callee.computed) return null
  if (name(node(callee.property)) !== 'map') return null
  const callback = nodes(expr.arguments)[0]
  if (!callback || (callback.type !== 'ArrowFunctionExpression' && callback.type !== 'FunctionExpression')) return null
  return { array: node(callee.object), callback }
}

function lowerElement(element: Node, path: number[], em: Emitter, input: LowerInput): void {
  const opening = node(element.openingElement)
  const tag = name(node(opening.name))
  if (!/^[a-z][a-z0-9-]*$/.test(tag)) {
    throw fail(input, element, 'E_COMPONENT_UNSUPPORTED', `<${tag}> is a component; the prototype lowers HTML elements only`)
  }

  text(em, `<${tag}`)
  for (const raw of nodes(opening.attributes)) lowerAttribute(raw, path, em, input)
  text(em, '>')

  if (VOID_ELEMENTS.has(tag)) {
    if (nodes(element.children).filter(isSurviving).length) {
      throw fail(input, element, 'E_VOID_CHILDREN', `<${tag}> is a void element and cannot have children`)
    }
    return
  }

  lowerChildren(nodes(element.children), path, em, input, tag)
  text(em, `</${tag}>`)
}

function lowerAttribute(attribute: Node, path: number[], em: Emitter, input: LowerInput): void {
  if (attribute.type === 'JSXSpreadAttribute') {
    throw fail(input, attribute, 'E_SPREAD_UNSUPPORTED', 'spread attributes hide what the template can contain')
  }
  const attr = name(node(attribute.name))
  if (attr === 'key') return

  const value = attribute.value === null || attribute.value === undefined ? null : node(attribute.value)

  if (value === null) {
    text(em, ` ${attr}`)
    return
  }

  if (value.type === 'Literal') {
    text(em, ` ${attr}="${escapeStatic(String(value.value ?? ''), true)}"`)
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
    const folded = classified.escape === 'trusted-raw' ? classified.constant : escapeStatic(classified.constant, true)
    text(em, ` ${attr}="${folded}"`)
    return
  }

  if (BOOLEAN_ATTRIBUTES.has(attr)) {
    text(em, ' ')
    hole(em, { kind: 'attr-bool', escape: 'proven-safe', binding: classified.binding, path, attr })
    if (classified.signal) em.wiring.push({ path, op: 'bool', binding: classified.binding, attr })
    return
  }

  text(em, ` ${attr}="`)
  hole(em, {
    kind: 'attr',
    escape: classified.escape,
    binding: classified.binding,
    path,
    attr,
    ...(classified.provenance ? { provenance: classified.provenance } : {}),
  })
  text(em, '"')
  if (classified.signal) em.wiring.push({ path, op: 'attr', binding: classified.binding, attr })
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
    throw fail(input, expression, 'E_HANDLER_NOT_IMPORTED', `${local} is not imported, so it has no stable intent id`)
  }
  em.wiring.push({
    path,
    op: 'event',
    binding: '',
    event,
    intent: intentId(imported.module, imported.exported),
  })
}

function lowerChildren(children: Node[], path: number[], em: Emitter, input: LowerInput, parentTag: string): void {
  const surviving = children.filter(isSurviving)
  let elementIndex = 0

  surviving.forEach((child, i) => {
    if (child.type === 'JSXText') {
      text(em, escapeStatic(trimJsxText(String(child.value ?? '')), false))
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
      text(em, classified.escape === 'trusted-raw' ? classified.constant : escapeStatic(classified.constant, false))
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
      text(em, '<!>')
      anchor = em.markers++
    }

    hole(em, {
      kind: 'text',
      escape: classified.escape,
      binding: classified.binding,
      path,
      ...(classified.provenance ? { provenance: classified.provenance } : {}),
    })

    const next = surviving[i + 1]
    if (!sole && next && next.type === 'JSXText') {
      text(em, '<!>')
      em.markers++
    }

    if (classified.signal) {
      em.wiring.push({
        path,
        op: 'text',
        binding: classified.binding,
        ...(anchor !== undefined ? { anchor } : {}),
      })
    }
  })
}

function lowerList(list: { array: Node; callback: Node }, path: number[], em: Emitter, input: LowerInput): void {
  const arrayBinding = classify(list.array, input, em)
  const param = nodes(list.callback.params)[0]
  if (!param || param.type !== 'Identifier') {
    throw fail(input, list.callback, 'E_MAP_PARAM', 'the row callback needs a single named parameter')
  }

  const body = node(list.callback.body)
  const rowRoot = body.type === 'BlockStatement' ? returnedJsx(body, input) : body
  const id = `${input.id}:${arrayBinding.binding}[]`

  const lowered = lower({
    id,
    root: rowRoot,
    file: input.file,
    source: input.source,
    scope: { ...input.scope, itemParam: name(param), signals: input.scope.signals },
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
