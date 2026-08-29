import type { ClientDerived, ClientExpr, Json } from './template.ts'
import { computed, type Readable } from './signal.ts'

/**
 * The client half of a derived value. The expression arrived on the wire, so nothing is
 * compiled here and no component runs — evaluating it is a walk over four node shapes,
 * and wrapping that walk in a computed is what makes the result reactive.
 */
export function evaluate(expr: ClientExpr, read: (id: string) => Json | undefined): Json {
  if (expr.k === 'lit') return expr.v
  if (expr.k === 'ref') return read(expr.id) ?? null
  if (expr.k === 'un') return unary(expr.op, evaluate(expr.a, read))
  // Truthiness, lazily; `??` and `||` lower onto it. See `@weftjs/ir`'s `DerivedExpr` for why.
  if (expr.k === 'cond') return evaluate(expr.a, read) ? evaluate(expr.b, read) : evaluate(expr.c, read)
  return binary(expr.op, evaluate(expr.a, read), evaluate(expr.b, read))
}

function unary(op: string, a: Json): Json {
  if (op === '!') return !a
  if (op === '-') return -(a as number)
  if (op === '+') return +(a as number)
  return ~(a as number)
}

function binary(op: string, a: Json, b: Json): Json {
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

/** Turns the template's derived table into readables. Only the decls that reach a signal are bound. See `spec/client/adoption.md`. */
export function bindDerived(
  decls: readonly ClientDerived[] | undefined,
  signals: Record<string, Readable<unknown>> | undefined,
): Record<string, Readable<unknown>> {
  if (!decls || decls.length === 0 || !signals) return signals ?? {}
  const all: Record<string, Readable<unknown>> = { ...signals }
  for (const decl of decls) {
    const expr = decl.expr
    if (!reaches(expr, all)) continue
    all[decl.id] = computed(() => evaluate(expr, (id) => all[id]?.() as Json | undefined))
  }
  return all
}

/** Whether any binding this reads is one the client holds. Every operand is `a`, `b` or `c`, so one
 * walk covers every node kind; an untaken branch still counts, because the test selects it. */
function reaches(expr: ClientExpr, bound: Record<string, Readable<unknown>>): boolean {
  if (expr.k === 'ref') return expr.id in bound
  const operands = expr as { a?: ClientExpr; b?: ClientExpr; c?: ClientExpr }
  return [operands.a, operands.b, operands.c].some((operand) => !!operand && reaches(operand, bound))
}
