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

/**
 * Turns the template's derived table into readables, in declaration order so one may
 * read another. Only the decls that reach a signal are bound: the rest are server-owned,
 * and a computed over bindings the client does not hold would evaluate to null and
 * overwrite a perfectly good server render.
 */
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

function reaches(expr: ClientExpr, bound: Record<string, Readable<unknown>>): boolean {
  if (expr.k === 'ref') return expr.id in bound
  if (expr.k === 'un') return reaches(expr.a, bound)
  if (expr.k === 'bin') return reaches(expr.a, bound) || reaches(expr.b, bound)
  return false
}
