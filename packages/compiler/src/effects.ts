import type { EffectSet } from '@weftjs/ir'
import { name, node, nodes, type Node } from './ast.ts'
import { CompileError, locate } from './errors.ts'

/**
 * The read surface, and nothing else taints. A call on the context that is not in this
 * table is a compile error rather than an untracked read, because the whole cacheability
 * story is derived from this set being complete.
 */
const READS: Record<string, (argument?: Node) => string> = {
  // A flag is referenced, so an imported identifier is the normal way to name one.
  flag: (a) => `flag:${flagName(a)}`,
  // A key is data, so it has to be a literal: a computed key cannot be part of a cache key.
  cookie: (a) => `cookie:${literalKey(a)}`,
  header: (a) => `header:${literalKey(a)}`,
  param: (a) => `route:${literalKey(a)}`,
  query: (a) => `route:${literalKey(a)}`,
  locale: () => 'locale',
  device: () => 'device',
  user: () => 'identity',
  now: () => 'time',
  raw: () => 'opaque',
}

/** Setting a cookie or a status during a render is the thing the envelope phase exists to prevent. */
const ENVELOPE_METHODS = new Set(['setCookie', 'status', 'redirect', 'header$set'])

/**
 * Ambient reads that would make a render depend on something the compiler cannot see. The
 * design's warning is that one of these punches a hole in the entire cacheability
 * guarantee, so it is a hard error with a named alternative, not a lint note.
 */
const BANNED_OBJECTS: Record<string, string> = {
  process: 'read configuration through a port, or ctx.raw() if it truly is opaque',
  globalThis: 'nothing ambient is visible to the compiler',
  window: 'a fragment renders on the server; take what you need from ctx',
  document: 'a fragment renders on the server; take what you need from ctx',
  location: 'use ctx.param(), ctx.query(), or ctx.header()',
  navigator: 'use ctx.device() or ctx.locale()',
}

const BANNED_CALLS: Record<string, string> = {
  'Date.now': 'ctx.now(), which taints time and forces a TTL',
  'Math.random': 'a value passed in, or ctx.raw() if the fragment is genuinely uncacheable',
  'performance.now': 'ctx.now()',
}

export interface EffectInput {
  fn: Node
  ctxParam?: string
  file: string
  source: string
}

export interface InferredEffects extends EffectSet {
  /** Reads whose value has to appear in the cache key, in the order they were found. */
  order: string[]
}

function literalKey(argument: Node | undefined): string {
  if (argument?.type === 'Literal' && typeof argument.value === 'string') return argument.value
  throw new Error(
    'E_TAINT_ARGUMENT: a read has to name what it reads with a string literal. ' +
      'The name becomes a cache key component, so a computed one is a key nobody can predict ' +
      "— write ctx.cookie('currency') rather than ctx.cookie(key)",
  )
}

function flagName(argument: Node | undefined): string {
  if (argument?.type === 'Identifier') return kebab(name(argument))
  if (argument?.type === 'Literal' && typeof argument.value === 'string') return argument.value
  throw new Error('E_TAINT_ARGUMENT')
}

function kebab(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

/**
 * Walks the whole fragment, not only its JSX: a read in a variable declaration taints just
 * as much as one in an attribute. Reads are sorted, because a cache key derived from them
 * must not depend on the order somebody happened to write them in.
 */
export function inferEffects(input: EffectInput): InferredEffects {
  const reads = new Set<string>()
  const order: string[] = []
  const fail = (at: Node, code: string, message: string): CompileError =>
    new CompileError(code, message, locate(input.file, input.source, at.start ?? 0))

  const record = (taint: string): void => {
    if (!reads.has(taint)) order.push(taint)
    reads.add(taint)
  }

  walk(node(input.fn.body), (current) => {
    if (current.type === 'CallExpression') {
      const callee = node(current.callee)

      if (callee.type === 'MemberExpression' && !callee.computed) {
        const object = node(callee.object)
        const method = name(node(callee.property))

        if (object.type === 'Identifier' && name(object) === input.ctxParam) {
          if (ENVELOPE_METHODS.has(method)) {
            throw fail(
              current,
              'E_ENVELOPE_IN_RENDER',
              `ctx.${method}() cannot run during a render — a response's envelope is settled before any hole is filled`,
            )
          }
          const taintOf = READS[method]
          if (!taintOf) {
            throw fail(
              current,
              'E_UNKNOWN_EFFECT',
              `ctx.${method}() is not a read this compiler knows, so its taint cannot be derived. The read surface is flag, cookie, header, param, query, locale, device, user, now, raw`,
            )
          }
          const argument = nodes(current.arguments)[0]
          try {
            record(taintOf(argument))
          } catch {
            throw fail(
              current,
              'E_DYNAMIC_TAINT',
              `ctx.${method}() needs a statically known argument, otherwise the cache key cannot be derived from it`,
            )
          }
          return
        }

        if (object.type === 'Identifier') {
          const banned = BANNED_CALLS[`${name(object)}.${method}`]
          if (banned) {
            throw fail(
              current,
              'E_UNTRACKED_EFFECT',
              `${name(object)}.${method}() is an untracked read, which would make this fragment's cache key a lie. Use ${banned}`,
            )
          }
        }
      }
      return
    }

    if (current.type === 'NewExpression') {
      const callee = node(current.callee)
      if (callee.type === 'Identifier' && name(callee) === 'Date' && nodes(current.arguments).length === 0) {
        throw fail(
          current,
          'E_UNTRACKED_EFFECT',
          'new Date() is an untracked read of the clock. Use ctx.now(), which taints time and forces a TTL',
        )
      }
      return
    }

    if (current.type === 'MemberExpression') {
      const object = node(current.object)
      if (object.type === 'Identifier') {
        const banned = BANNED_OBJECTS[name(object)]
        if (banned) {
          throw fail(
            current,
            'E_UNTRACKED_EFFECT',
            `${name(object)} is not visible to the compiler, so a read of it cannot taint this fragment. Instead: ${banned}`,
          )
        }
      }
    }
  })

  const sorted = [...reads].sort()
  return {
    reads: sorted,
    writes: [],
    envelope: [],
    residency: sorted.length ? 'server' : 'either',
    order,
  }
}

function walk(root: Node, visit: (current: Node) => void): void {
  const stack: Node[] = [root]
  while (stack.length) {
    const current = stack.pop() as Node
    visit(current)
    for (const value of Object.values(current)) {
      if (Array.isArray(value)) {
        for (const item of value)
          if (item && typeof item === 'object' && 'type' in item) stack.push(node(item))
      } else if (value && typeof value === 'object' && 'type' in (value as Node)) {
        stack.push(node(value))
      }
    }
  }
}

/**
 * The reads a route's own loader performs, which its slots' cache keys have to contain.
 *
 * Deliberately not `inferEffects`, and the difference is the whole reason this exists. A fragment's
 * context is a closed surface: anything on it the table below does not name is a compile error,
 * because a fragment that read something the compiler could not see would make its key a lie. A
 * loader's context is wider on purpose — `ctx.data(...)`, `ctx.revalidate(...)` — so running the
 * fragment walk over a `.data.ts` would refuse every application that has one.
 *
 * What the two share is the table. A read that taints in a fragment taints in a loader, for the
 * same reason and into the same key. This collects exactly those and steps over everything else.
 *
 * The bug it closes: a route's loader lives in a file the compiler never read, so `ctx.query('rows')`
 * tainted nothing, the key could not contain it, and whichever value rendered first answered for
 * every other one until the entry expired. Route params had already been patched around this by
 * being folded into a slot's identity; a query string had not, and there is no bound on one to fold.
 *
 * Per file rather than per slot, and that is the conservative direction rather than a shortcut. A
 * read in one slot's loader taints every slot on the route, which costs a cache entry that could
 * have been shared. The opposite error costs a wrong page.
 */
export function inferLoaderReads(input: { file: string; source: string; program: Node }): string[] {
  /**
   * Which identifiers are a context, taken from every function in the file.
   *
   * A loader is written `(ctx) => …`, `(ctx, params) => …`, `(_ctx, params) => …`, and as a method
   * shorthand — so the name is whatever that function called its first parameter rather than a word
   * this can look for. Collected across the file and then matched, which over-collects only when
   * something unrelated shares the name, and over-collecting taints an extra read: another cache
   * entry, never a wrong one.
   */
  const contexts = new Set<string>()
  /**
   * Named local helpers, by the parameter names they take and the arguments they are called with.
   *
   * `const slow = (ctx, key, fallback) => Number(ctx.query(key) ?? fallback)` is how a loader with
   * three sliders is actually written, and the read inside it names a parameter rather than a
   * string. Refusing that would be refusing the idiom rather than the ambiguity: the *call sites*
   * name it, every one of them, a few lines further down. So one level of indirection is resolved —
   * a parameter's name is looked up in the calls to the function that takes it — and anything
   * beyond one level is refused, because a chain of two is a key nobody can follow either.
   */
  const takes = new Map<string, string[]>()
  const calls = new Map<string, Node[][]>()

  walk(input.program, (current) => {
    if (
      current.type === 'ArrowFunctionExpression' ||
      current.type === 'FunctionExpression' ||
      current.type === 'FunctionDeclaration'
    ) {
      const params = nodes(current.params).map((p) => {
        const target = p.type === 'AssignmentPattern' ? node(p.left) : p
        return target.type === 'Identifier' ? name(target) : ''
      })
      if (params[0]) contexts.add(params[0] as string)
      const own = current.type === 'FunctionDeclaration' ? name(node(current.id)) : ''
      if (own) takes.set(own, params)
      return
    }
    if (current.type === 'VariableDeclarator') {
      const init = node(current.init)
      const id = node(current.id)
      if (
        id.type === 'Identifier' &&
        (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')
      ) {
        takes.set(
          name(id),
          nodes(init.params).map((p) => {
            const target = p.type === 'AssignmentPattern' ? node(p.left) : p
            return target.type === 'Identifier' ? name(target) : ''
          }),
        )
      }
      return
    }
    if (current.type === 'CallExpression') {
      const callee = node(current.callee)
      if (callee.type === 'Identifier') {
        const at = calls.get(name(callee)) ?? []
        at.push(nodes(current.arguments))
        calls.set(name(callee), at)
      }
    }
  })
  if (!contexts.size) return []

  const reads = new Set<string>()
  const refuse = (method: string, at: Node, why: string): never => {
    throw new CompileError(
      'E_DYNAMIC_TAINT',
      `ctx.${method}() in a loader ${why}: the name becomes a cache key component, and a computed one is a key nobody can predict`,
      locate(input.file, input.source, at.start ?? 0),
    )
  }

  /** The literals a helper's parameter is ever called with, or null when one call did not name it. */
  const throughCallSites = (parameter: string): string[] | null => {
    const found: string[] = []
    let named = false
    for (const [helper, params] of takes) {
      const at = params.indexOf(parameter)
      if (at === -1) continue
      const sites = calls.get(helper)
      if (!sites?.length) continue
      named = true
      for (const site of sites) {
        const argument = site[at]
        if (argument?.type === 'Literal' && typeof argument.value === 'string') found.push(argument.value)
        else return null
      }
    }
    return named ? found : null
  }

  walk(input.program, (current) => {
    if (current.type !== 'CallExpression') return
    const callee = node(current.callee)
    if (callee.type !== 'MemberExpression' || callee.computed) return
    const object = node(callee.object)
    if (object.type !== 'Identifier' || !contexts.has(name(object))) return
    const method = name(node(callee.property))
    const taintOf = READS[method]
    if (!taintOf) return
    const argument = nodes(current.arguments)[0]
    try {
      reads.add(taintOf(argument))
      return
    } catch {
      // Not a literal. One level of indirection is resolved before this is refused.
    }
    if (argument?.type !== 'Identifier') refuse(method, current, 'needs a statically known argument')
    const through = throughCallSites(name(argument))
    if (!through) {
      refuse(
        method,
        current,
        `is passed ${name(argument)}, and the calls to the helper taking it do not name it with a string literal either`,
      )
    }
    // Through `taintOf` rather than a `route:` prefix written here: the same indirection is legal
    // for a cookie and a header, and each of those has its own prefix.
    for (const key of through as string[]) {
      reads.add(taintOf({ type: 'Literal', value: key } as unknown as Node))
    }
  })
  return [...reads].sort()
}
