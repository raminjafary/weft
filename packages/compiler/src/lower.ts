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
  FRAMEWORK_MODULE,
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

/** Where a tag came from: the module specifier and the export, exactly as written. */
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

/** What names are in scope while lowering, so a prop and a signal can be told apart. */
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
  /**
   * Set inside a list row that named a second parameter: the row's position.
   *
   * A row is its own template and receives only its item, which is what makes a row count a value
   * and not a re-render. The index is the one exception the position itself justifies: it is a fact
   * about where the row sits, supplied by whatever renders the rows, so it costs the row no closure
   * over the outer scope and the list no cache identity.
   */
  indexParam?: string
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
  /**
   * Whose markup this is. A `row` and a `children` template are the parent's own markup cut
   * into a template of its own; a `component` is another fragment. The difference decides
   * whether a decision the parent makes about its instances — isolation, above all — reaches
   * inside it or stops at the boundary.
   */
  kind: 'row' | 'component' | 'children' | 'variant'
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

/** The result: segments, holes, wiring, and the nested templates a list or instance needs. */
export interface Lowered {
  id: string
  parts: string[]
  holes: Hole[]
  wiring: WiringEntry[]
  signals: SignalDecl[]
  derived: DerivedDecl[]
  nested: NestedRequest[]
  markers: number
  /**
   * Ids of the fragments this one renders, so a caller can union their effects. Instances
   * inside a row or inside children markup are in here too: they are the caller's markup,
   * and a read does not stop being the caller's because it happened one template down.
   */
  components: string[]
  /**
   * Set when this template's markup interpolated its list item directly.
   *
   * Read by the list hole that owns the row, because the row is lowered before its hole is emitted
   * and the two are lowered through separate emitters.
   */
  rowValue?: string
  /**
   * Whether the template is exactly one element and nothing else. An instance occupies one
   * element position in its caller, so a child with two roots — or with a bare text root —
   * would shift every sibling after it.
   */
  singleRoot: boolean
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
  /**
   * Set while lowering a row whose markup interpolates the item itself.
   *
   * Read by the list hole that owns the row, so the renderer knows to wrap each item rather than
   * spread it. It lives on the emitter because the row is lowered before its hole is emitted.
   */
  rowValue?: string
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

/** What lowering needs: the JSX, the scope around it, and the type oracle if there is one. */
export interface LowerInput {
  id: string
  root: Node
  scope: Scope
  file: string
  source: string
  /** When present, escaping is decided by the value's type rather than by its syntax. */
  types?: TypeOracle
  /**
   * The scope this fragment's stylesheet was rewritten under, when it brought a scoped one.
   *
   * Every element the fragment declares gets it as an attribute, so a selector carrying the same
   * attribute matches this fragment's elements and nothing else on the page. It is stamped here
   * rather than applied in the browser because a template is data: the attribute becomes part of
   * the sealed bytes, costs one attribute per element on the wire and nothing at all at runtime.
   *
   * It stops at a component boundary. A `<Card/>` is its own sealed template and does not inherit
   * this, which is the whole point — a parent that could reach into a child's markup would make the
   * child's shape part of the parent's contract.
   */
  cssScope?: string
  /**
   * A derived table to append to rather than start. Children markup is lowered into a
   * template of its own but stays in its caller's binding namespace, so the two share one
   * table — otherwise both would allocate `d0` for different expressions and the shared
   * value set would have to hold two of them.
   */
  derived?: DerivedDecl[]
}

/** JSX to segments and holes. Every expression it cannot lower is refused by name. */
export function lower(input: LowerInput): Lowered {
  const em: Emitter = {
    parts: [],
    buffer: '',
    holes: [],
    wiring: [],
    nested: [],
    markers: 0,
    derived: input.derived ?? [],
    components: [],
  }
  const root = input.root
  let singleRoot = false
  if (root.type === 'JSXFragment') {
    const surviving = nodes(root.children).filter(isSurviving)
    singleRoot = surviving.length === 1 && (surviving[0] as Node).type === 'JSXElement'
    lowerChildren(nodes(root.children), [], em, input, '')
  } else if (root.type === 'JSXElement') {
    singleRoot = true
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
    ...(em.rowValue ? { rowValue: em.rowValue } : {}),
    singleRoot,
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
      // The item itself, which a row over primitives has nothing else to name. Recorded on the list
      // hole so the renderer wraps each one; a row that reads fields never reaches this line.
      em.rowValue = ident
      return { binding: ident, escape: 'escape' }
    }
    if (scope.indexParam && ident === scope.indexParam) {
      // A number, so nothing it renders into can hold markup.
      return { binding: ident, escape: 'proven-safe' }
    }
    if (scope.itemParam) throw outOfRowScope(input, expr, ident)
    if (ident === 'children' && scope.props.has('children')) {
      throw fail(
        input,
        expr,
        'E_CHILDREN_NOT_A_VALUE',
        'children is markup a caller wrote, not a value; interpolate it as the only child of an element',
      )
    }
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
      if (imported && imported.exported === 'raw' && imported.module === FRAMEWORK_MODULE) {
        const argument = nodes(expr.arguments)[0]
        if (!argument) throw fail(input, expr, 'E_RAW_EMPTY', 'raw() needs an argument')
        const inner = classify(argument, input, em)
        return { ...inner, escape: 'trusted-raw', provenance: source(input, argument) }
      }
    }
    throw fail(input, expr, 'E_EXPRESSION_UNSUPPORTED', `cannot resolve ${source(input, expr)} to a binding`)
  }

  if (
    expr.type === 'UnaryExpression' ||
    expr.type === 'BinaryExpression' ||
    expr.type === 'ConditionalExpression' ||
    expr.type === 'LogicalExpression' ||
    expr.type === 'TemplateLiteral'
  ) {
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

/**
 * Arithmetic and comparison cannot produce markup; `+` and logical operators can.
 *
 * A conditional, a coalesce and a template literal all can, so all three escape. That is stricter
 * than necessary for `on ? 1 : 2`, whose arms are both numbers — but elision here is a claim about a
 * *type*, and the checker answers that question for whole holes rather than for the arms of an
 * expression. Escaping a number produces the same bytes as not escaping it, so the cost of being
 * conservative is nothing, and the cost of being wrong is an injection.
 */
function provablyNotMarkup(expr: Node): boolean {
  if (expr.type === 'UnaryExpression') return ['!', '-', '+', '~'].includes(String(expr.operator))
  if (expr.type !== 'BinaryExpression') return false
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

  if (expr.type === 'ConditionalExpression') {
    return {
      k: 'cond',
      a: derivedExpr(node(expr.test), input, em, reads, refs),
      b: derivedExpr(node(expr.consequent), input, em, reads, refs),
      c: derivedExpr(node(expr.alternate), input, em, reads, refs),
    }
  }

  /**
   * `??` and `||` are the same node as `? :`, which is why neither has one of its own.
   *
   * `a || b` is `a ? a : b` — the left operand is named twice in the tree and evaluated once,
   * because `cond` is lazy in its arms. `a ?? b` is the same over a `!== null` test rather than a
   * truthiness one, and one comparison covers both null and undefined because a `ref` to an absent
   * binding already reads as `null` on both sides.
   *
   * `&&` is deliberately not here. `a && b` in a hole is nearly always meant structurally — show
   * this when that — and lowering it to a value would render the string `false` where the author
   * expected nothing. It keeps its refusal until a template can hold a shape.
   */
  if (expr.type === 'LogicalExpression') {
    const op = String(expr.operator)
    if (op === '&&') {
      throw fail(
        input,
        expr,
        'E_EXPRESSION_UNSUPPORTED',
        '`&&` in a hole reads as a shape rather than a value, and a sealed template holds one value ' +
          "per hole; write a conditional value (`a ? b : ''`) or move the choice into the loader",
      )
    }
    if (op !== '||' && op !== '??') {
      throw fail(input, expr, 'E_OPERATOR_UNSUPPORTED', `logical ${op} cannot be evaluated on the client`)
    }
    const left = derivedExpr(node(expr.left), input, em, reads, refs)
    const right = derivedExpr(node(expr.right), input, em, reads, refs)
    const test: DerivedExpr = op === '??' ? { k: 'bin', op: '!==', a: left, b: { k: 'lit', v: null } } : left
    return { k: 'cond', a: test, b: left, c: right }
  }

  /**
   * A template literal is a `+` chain, not a node of its own.
   *
   * `+` on a string already concatenates — the `as number` in the evaluators is a type assertion and
   * not a coercion — so the existing binary node covers this and the client needs no new arm for it.
   * The quasis are literals and the expressions are leaves, in source order.
   */
  if (expr.type === 'TemplateLiteral') {
    const quasis = nodes(expr.quasis)
    const parts = nodes(expr.expressions)
    let out: DerivedExpr | undefined
    const join = (next: DerivedExpr): void => {
      out = out === undefined ? next : { k: 'bin', op: '+', a: out, b: next }
    }
    for (let i = 0; i < quasis.length; i++) {
      const cooked = node(quasis[i] as Node).value as { cooked?: unknown } | undefined
      const text = String((cooked?.cooked as string | undefined) ?? '')
      // An empty piece contributes nothing rather than an empty literal, which keeps `${a}${b}`
      // from carrying three constants nobody reads.
      if (text !== '') join({ k: 'lit', v: text })
      const inner = parts[i]
      if (inner) join(derivedExpr(node(inner), input, em, reads, refs))
    }
    return out ?? { k: 'lit', v: '' }
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

/** One test on the way to a branch, and whether it has to be false for the branch to render. */
interface Condition {
  test: Node
  negated: boolean
}

/** One arm of a conditional shape: the markup, and every test that has to hold for it to render. */
interface Branch {
  conditions: Condition[]
  markup: Node
}

const isMarkup = (n: Node): boolean => n.type === 'JSXElement' || n.type === 'JSXFragment'

/**
 * A conditional whose arms are markup, flattened into the branches a template can seal.
 *
 * Recursive, because `a ? <X/> : b ? <Y/> : <Z/>` is the shape a three-way choice is written in and
 * its alternate is another conditional rather than markup. Each branch collects the tests on the way
 * to it — `<Y/>` renders when `!a && b` — so a chain of any depth becomes a flat list of arms, each
 * with its own conjunction.
 *
 * Returns null for a conditional whose arms are values: those are a `cond` in the derived table and
 * stay one hole, which is cheaper and leaves the markup identical. A conditional mixing a shape and
 * a value is refused by the caller rather than guessed at.
 */
function jsxBranches(expr: Node, prefix: Condition[] = []): Branch[] | null {
  if (expr.type === 'LogicalExpression' && String(expr.operator) === '&&') {
    const right = node(expr.right)
    if (!isMarkup(right)) return null
    return [{ conditions: [...prefix, { test: node(expr.left), negated: false }], markup: right }]
  }

  if (expr.type !== 'ConditionalExpression') return null

  const test = node(expr.test)
  const consequent = node(expr.consequent)
  const alternate = node(expr.alternate)

  const whenTrue: Condition[] = [...prefix, { test, negated: false }]
  const whenFalse: Condition[] = [...prefix, { test, negated: true }]

  const left = isMarkup(consequent)
    ? [{ conditions: whenTrue, markup: consequent }]
    : jsxBranches(consequent, whenTrue)
  const right = isMarkup(alternate)
    ? [{ conditions: whenFalse, markup: alternate }]
    : jsxBranches(alternate, whenFalse)

  // Neither arm is a shape: a value conditional, and not this lowering's business.
  if (!left && !right) return null
  /**
   * One arm is a shape and the other is a value, which is refused rather than rendered.
   *
   * Silently dropping the value arm is what the first version of this function did, and
   * `{a ? <i>A</i> : b ? <b>B</b> : <s>C</s>}` rendered nothing at all when `a` was false. A missing
   * arm is a wrong page, so it is a refusal.
   */
  if (!left || !right) {
    return (left ?? right) as Branch[]
  }
  return [...left, ...right]
}

/** Whether every arm of a conditional resolved to markup, so none was quietly dropped. */
function everyArmIsShape(expr: Node): boolean {
  if (expr.type === 'LogicalExpression') return isMarkup(node(expr.right))
  if (expr.type !== 'ConditionalExpression') return isMarkup(expr)
  return everyArmIsShape(node(expr.consequent)) && everyArmIsShape(node(expr.alternate))
}

/**
 * One branch, sealed as its own template behind a `variant` hole.
 *
 * Lowered in *this* fragment's scope and sharing its derived table, the way a component's children
 * are: the markup was written here, so it reads this fragment's props and signals directly and needs
 * no projection.
 *
 * The conditions become one binding. A single positive test is used as it stands; anything else is
 * built in the derived table out of `cond`, because `&&` is not in the closed operator set and does
 * not need to be — `x && y` is `x ? y : false`, and a negation is `x ? false : true`.
 */
function lowerBranch(branch: Branch, path: number[], em: Emitter, input: LowerInput): void {
  const FALSE: DerivedExpr = { k: 'lit', v: false }
  const TRUE: DerivedExpr = { k: 'lit', v: true }

  const asExpr = (condition: Condition): DerivedExpr => {
    const tested = classify(condition.test, input, em)
    if (tested.signal || tested.reactive) {
      const named = tested.signal?.id ?? tested.binding
      throw fail(
        input,
        condition.test,
        'E_BRANCH_ON_SIGNAL',
        `this branch is decided by signal ${named}, and a branch is chosen by the server — nothing ` +
          'on the client swaps one sealed subtree for another, so it would render once and never ' +
          'change. Use a conditional value, which is reactive, or choose in a loader',
      )
    }
    const ref: DerivedExpr = { k: 'ref', id: tested.binding }
    return condition.negated ? { k: 'cond', a: ref, b: FALSE, c: TRUE } : ref
  }

  let expr = asExpr(branch.conditions[0] as Condition)
  for (const condition of branch.conditions.slice(1)) {
    // `earlier && next`, as a conditional value.
    expr = { k: 'cond', a: expr, b: asExpr(condition), c: FALSE }
  }

  let binding: string
  const only = branch.conditions.length === 1 ? (branch.conditions[0] as Condition) : undefined
  if (only && !only.negated && expr.k === 'ref') {
    binding = expr.id
  } else {
    binding = `d${em.derived.length}`
    em.derived.push({ id: binding, expr })
  }

  const root =
    branch.markup.type === 'JSXFragment'
      ? node({ type: 'JSXFragment', children: branch.markup.children })
      : branch.markup
  const id = `${input.id}:${binding}?`

  const lowered = lower({
    id,
    root,
    file: input.file,
    source: input.source,
    scope: input.scope,
    derived: em.derived,
    ...(input.types ? { types: input.types } : {}),
  })
  em.components.push(...lowered.components)

  const holeIndex = hole(em, {
    kind: 'variant',
    escape: 'trusted-raw',
    binding,
    path,
    provenance: id,
  })
  em.nested.push({ holeIndex, id, kind: 'variant', lowered })
}

function lowerElement(element: Node, path: number[], em: Emitter, input: LowerInput): void {
  const opening = node(element.openingElement)
  const tag = name(node(opening.name))
  if (!/^[a-z][a-z0-9-]*$/.test(tag)) {
    lowerComponent(element, tag, path, em, input)
    return
  }

  emit(em, `<${tag}`)
  if (input.cssScope) emit(em, ` ${input.cssScope}`)
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
      `<${tag}> is not a fragment declared in this module, and no import resolves to one; a cross-module child has to be in the file set compileFiles was given`,
    )
  }

  const binding = `c${em.components.length}`
  const props: Record<string, string> = {}
  const events: { attr: string; expression: Node }[] = []
  for (const raw of nodes(node(element.openingElement).attributes)) {
    const attribute = node(raw)
    if (attribute.type === 'JSXSpreadAttribute') {
      throw fail(input, attribute, 'E_SPREAD_UNSUPPORTED', 'spread attributes hide what a component receives')
    }
    const prop = name(node(attribute.name))
    if (prop === 'key') continue
    if (/^on[A-Z]/.test(prop)) {
      // An instance is one element, so an intent has an element to bind to: the instance's
      // root, addressed by the hole's own path. The child never learns about it, which is
      // what keeps a listener out of the child's shared template.
      const value = attribute.value === null || attribute.value === undefined ? null : node(attribute.value)
      if (!value || value.type !== 'JSXExpressionContainer') {
        throw fail(
          input,
          attribute,
          'E_HANDLER_NOT_AN_INTENT',
          `${prop} on <${tag}> must reference an intent`,
        )
      }
      events.push({ attr: prop, expression: node(value.expression) })
      continue
    }
    if (prop === 'children') {
      throw fail(
        input,
        attribute,
        'E_CHILDREN_AS_PROP',
        `children is markup rather than a value; write it between <${tag}> and </${tag}>`,
      )
    }
    if (!ref.props.has(prop)) {
      throw fail(input, attribute, 'E_COMPONENT_PROP_UNKNOWN', `${tag} does not declare a prop named ${prop}`)
    }
    props[prop] = componentProp(attribute, prop, tag, em, input)
  }

  const written = nodes(element.children).filter(isSurviving)
  const takesChildren = ref.props.has('children')
  if (written.length && !takesChildren) {
    throw fail(
      input,
      element,
      'E_COMPONENT_CHILDREN_UNDECLARED',
      `<${tag}> is given children and does not declare a children prop; add one and interpolate it as {children}`,
    )
  }

  for (const declared of ref.props) {
    if (declared === 'children') {
      if (!written.length) {
        throw fail(
          input,
          element,
          'E_COMPONENT_PROP_MISSING',
          `${tag} declares a children prop and this use site writes nothing between its tags`,
        )
      }
      continue
    }
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
  const single = ref.sealed ? ref.sealed.entry.meta?.singleRoot === true : (child as Lowered).singleRoot
  if (!single || child.holes.some((h) => h.path.length === 0)) {
    throw fail(
      input,
      element,
      'E_COMPONENT_NOT_SINGLE_ROOT',
      `<${tag}> must render a single root element: an instance occupies one element position in its caller`,
    )
  }

  // The children go into a template of their own, sealed like a row, but lowered in *this*
  // fragment's scope: the markup was written here, so it reads this fragment's props and
  // signals. That is also why the two share a derived table — one binding namespace, one
  // set of ids.
  let content: Lowered | undefined
  if (written.length) {
    content = lower({
      id: `${input.id}:${binding}<>`,
      root: node({ type: 'JSXFragment', children: element.children }),
      file: input.file,
      source: input.source,
      scope: input.scope,
      derived: em.derived,
      ...(input.types ? { types: input.types } : {}),
    })
    em.components.push(...content.components)
  }

  const holeIndex = hole(em, {
    kind: 'component',
    escape: 'trusted-raw',
    binding,
    path,
    props,
    provenance: ref.id,
  })
  em.components.push(ref.id)
  em.nested.push({
    holeIndex,
    id: ref.id,
    kind: 'component',
    ...(ref.sealed ? { sealed: ref.sealed } : { lowered: child as Lowered }),
  })
  if (content) {
    em.nested.push({ holeIndex, id: content.id, kind: 'children', lowered: content })
  }
  for (const { attr, expression } of events) lowerEvent(attr, expression, path, em, input)
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

    /**
     * A choice of markup, before it is tried as a value.
     *
     * `{on && <A/>}` and `{on ? <A/> : <B/>}` are shapes rather than values, and a hole holds one
     * value — so each branch is sealed as a template of its own and the hole says which. The layout
     * does not vary: both holes are always in the parent, and a falsy one writes nothing.
     */
    const branches = jsxBranches(expression)
    if (branches) {
      /**
       * Every arm has to be a shape, or the ones that are not would render as nothing.
       *
       * This is the refusal the first version of this lowering lacked:
       * `{a ? <i>A</i> : b ? <b>B</b> : 'C'}` sealed the two elements, dropped the string, and
       * rendered an empty element when `a` and `b` were both false. A missing arm is a wrong page,
       * so mixing the two is named rather than resolved.
       */
      if (!everyArmIsShape(expression)) {
        throw fail(
          input,
          child,
          'E_BRANCH_MIXES_SHAPE_AND_VALUE',
          'every arm of this conditional has to be markup, because the arms are sealed as templates ' +
            'and a value arm has no template to be. Wrap the value in an element, or make the whole ' +
            'conditional a value',
        )
      }
      /**
       * The same rule a list lives under, for exactly the same reason.
       *
       * A falsy branch writes nothing, so an element after it would sit at a different index
       * depending on a value — and every path in this template addresses element positions. Making
       * the conditional the sole child is what keeps a path a fact about the template rather than
       * about one render of it.
       */
      if (surviving.length !== 1) {
        throw fail(
          input,
          child,
          'E_BRANCH_NOT_SOLE_CHILD',
          'a conditional element must be the only child of its element, so that sibling positions ' +
            'cannot shift with which branch renders. Wrap it, or move the choice into the branches',
        )
      }
      let elementSlot = elementIndex
      for (const branch of branches) {
        lowerBranch(branch, [...path, elementSlot++], em, input)
      }
      // Every branch occupies its own element position, so a sibling after the conditional is
      // addressed past all of them whichever one renders.
      elementIndex = elementSlot
      return
    }

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

    // The place a caller's markup goes. It is a boundary rather than a value: the content is
    // its own sealed template, addressed from this element, so it has to own the element's
    // child positions outright — the same rule a list lives under, for the same reason.
    if (
      expression.type === 'Identifier' &&
      name(expression) === 'children' &&
      input.scope.props.has('children') &&
      !input.scope.itemParam
    ) {
      if (surviving.length !== 1) {
        throw fail(
          input,
          child,
          'E_CHILDREN_NOT_SOLE_CHILD',
          'children must be the only child of its element, so that a call site cannot shift the sibling positions this template addresses by',
        )
      }
      hole(em, {
        kind: 'children',
        escape: 'trusted-raw',
        binding: 'children',
        path,
        provenance: input.id,
      })
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
  const params = nodes(list.callback.params)
  const param = params[0]
  if (!param || param.type !== 'Identifier') {
    throw fail(input, list.callback, 'E_MAP_PARAM', 'the row callback needs a single named parameter')
  }
  const indexParam = params[1]
  if (indexParam !== undefined && node(indexParam).type !== 'Identifier') {
    throw fail(
      input,
      indexParam,
      'E_MAP_PARAM',
      "a row callback's second parameter is its position and has to be a plain name",
    )
  }
  const indexName = indexParam ? name(node(indexParam)) : undefined

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
    scope: {
      ...input.scope,
      itemParam: name(param),
      ...(indexName ? { indexParam: indexName } : {}),
      signals: input.scope.signals,
      locals: new Set(),
    },
  })

  // A row may render an instance of its own, and those reads are still this fragment's:
  // the row template is its markup, cut out so that a row count can change without moving
  // anything. Contagion follows the markup, not the template boundary.
  em.components.push(...lowered.components)

  const holeIndex = hole(em, {
    kind: 'list',
    escape: 'trusted-raw',
    binding: arrayBinding.binding,
    path,
    provenance: id,
    // Named on the hole so the renderer knows to supply them, and absent when unused so the row
    // loop keeps its fast path.
    ...(indexName ? { rowIndex: indexName } : {}),
    ...(lowered.rowValue ? { rowValue: lowered.rowValue } : {}),
  })
  em.nested.push({ holeIndex, id, kind: 'row', lowered })
}

/** The JSX a fragment body returns, past the statements that set up its signals. */
export function returnedJsx(block: Node, input: LowerInput): Node {
  for (const statement of nodes(block.body)) {
    if (statement.type === 'ReturnStatement') return node(statement.argument)
  }
  throw fail(input, block, 'E_NO_RETURN', 'a fragment body must return JSX')
}
