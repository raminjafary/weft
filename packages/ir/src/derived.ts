import type { BindingId, Json, Values } from './template-ir.ts'

/** The unary operators a derived expression may use. A closed set, because the client evaluates it. */
export type UnaryOp = '!' | '-' | '+' | '~'

/** The binary operators a derived expression may use. Also closed, and for the same reason. */
export type BinaryOp =
  '+' | '-' | '*' | '/' | '%' | '**' | '<' | '>' | '<=' | '>=' | '===' | '!==' | '==' | '!='

/** Every unary operator, for the validator. */
export const UNARY_OPS: readonly UnaryOp[] = ['!', '-', '+', '~']

/** Every binary operator, for the validator. */
export const BINARY_OPS: readonly BinaryOp[] = [
  '+',
  '-',
  '*',
  '/',
  '%',
  '**',
  '<',
  '>',
  '<=',
  '>=',
  '===',
  '!==',
  '==',
  '!=',
]

/** A computed value, encoded rather than compiled to a function. See `spec/ir/template-ir-2.md`. */
export type DerivedExpr =
  | { k: 'ref'; id: BindingId }
  | { k: 'lit'; v: Json }
  | { k: 'un'; op: UnaryOp; a: DerivedExpr }
  | { k: 'bin'; op: BinaryOp; a: DerivedExpr; b: DerivedExpr }
  /** A choice between two values — `a ? b : c`, with `a ?? b` and `a || b` lowered to it. See `spec/ir/template-ir-2.md`. */
  | { k: 'cond'; a: DerivedExpr; b: DerivedExpr; c: DerivedExpr }

/** A value computed from other bindings, as a tree rather than as code — no closure on the wire, no hydration to recompute. */
export interface DerivedDecl {
  id: BindingId
  expr: DerivedExpr
}

/** Every binding the expression reads, in first-seen order and without duplicates. */
export function readsOf(expr: DerivedExpr, out: BindingId[] = []): BindingId[] {
  if (expr.k === 'ref') {
    if (!out.includes(expr.id)) out.push(expr.id)
  } else if (expr.k === 'un') {
    readsOf(expr.a, out)
  } else if (expr.k === 'bin') {
    readsOf(expr.a, out)
    readsOf(expr.b, out)
  } else if (expr.k === 'cond') {
    // Every branch, not just the one taken. See `spec/ir/template-ir-2.md`.
    readsOf(expr.a, out)
    readsOf(expr.b, out)
    readsOf(expr.c, out)
  }
  return out
}

/** Total: a binding that is not there reads as null rather than throwing. See `spec/ir/template-ir-2.md`. */
export function evalDerived(expr: DerivedExpr, read: (id: BindingId) => Json | undefined): Json {
  if (expr.k === 'lit') return expr.v
  if (expr.k === 'ref') return read(expr.id) ?? null
  if (expr.k === 'un') return unary(expr.op, evalDerived(expr.a, read))
  // Lazy: a branch not taken must not be evaluated, or a `??` would touch bindings the render never read.
  if (expr.k === 'cond')
    return evalDerived(expr.a, read) ? evalDerived(expr.b, read) : evalDerived(expr.c, read)
  return binary(expr.op, evalDerived(expr.a, read), evalDerived(expr.b, read))
}

function unary(op: UnaryOp, a: Json): Json {
  if (op === '!') return !a
  if (op === '-') return -(a as number)
  if (op === '+') return +(a as number)
  return ~(a as number)
}

function binary(op: BinaryOp, a: Json, b: Json): Json {
  switch (op) {
    case '+':
      return (a as number) + (b as number)
    case '-':
      return (a as number) - (b as number)
    case '*':
      return (a as number) * (b as number)
    case '/':
      return (a as number) / (b as number)
    case '%':
      return (a as number) % (b as number)
    case '**':
      return (a as number) ** (b as number)
    case '<':
      return (a as number) < (b as number)
    case '>':
      return (a as number) > (b as number)
    case '<=':
      return (a as number) <= (b as number)
    case '>=':
      return (a as number) >= (b as number)
    case '===':
      return a === b
    case '!==':
      return a !== b
    case '==':
      // eslint-disable-next-line eqeqeq
      return a == b
    default:
      // eslint-disable-next-line eqeqeq
      return a != b
  }
}

/** Fills every derived binding into the value set, in declaration order. Always recomputed, never trusted from a reused value set. */
export function resolveDerived(decls: readonly DerivedDecl[], values: Values): Values {
  if (decls.length === 0) return values
  const out: Values = { ...values }
  for (const decl of decls) out[decl.id] = evalDerived(decl.expr, (id) => out[id])
  return out
}

/** The derived ids the client owns: those that reach a signal, directly or through another derived value. See `spec/ir/template-ir-2.md`. */
export function clientOwned(
  decls: readonly DerivedDecl[],
  signals: readonly { id: BindingId }[],
): Set<BindingId> {
  const owned = new Set<BindingId>(signals.map((s) => s.id))
  const out = new Set<BindingId>()
  for (const decl of decls) {
    if (readsOf(decl.expr).some((id) => owned.has(id))) {
      owned.add(decl.id)
      out.add(decl.id)
    }
  }
  return out
}
