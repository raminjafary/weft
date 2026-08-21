/**
 * Matching a URL to a plan.
 *
 * The router knows nothing about plans, fragments or rendering: it maps a path to a value
 * and a set of params, and the params are what the cache key reads through `ctx.param()`.
 * That separation is the whole reason it is fifty lines rather than a subsystem — a route is
 * not a place where behaviour lives, it is a name for a plan.
 *
 * Specificity decides matches, never declaration order. A table whose behaviour depends on
 * the order somebody happened to write it in is a table nobody can safely refactor.
 */
export class RouterError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(`${code} — ${message}`)
    this.name = 'RouterError'
    this.code = code
  }
}

export interface RouteEntry<T> {
  /** `/cart`, `/product/:sku`, `/checkout/*`. */
  pattern: string
  value: T
}

export interface Matched<T> {
  value: T
  pattern: string
  params: Record<string, string>
}

export interface Router<T> {
  match(url: URL | string): Matched<T> | null
  /**
   * The patterns in the order they will be tried. Where two of them could match one path the
   * more specific comes first, which is the only ordering guarantee worth making — between
   * patterns that cannot collide the order is deterministic and uninteresting.
   */
  readonly patterns: readonly string[]
}

type SegmentKind = 'static' | 'param' | 'wildcard'

interface Segment {
  kind: SegmentKind
  /** The literal for `static`, the name for `param`, unused for `wildcard`. */
  text: string
}

interface Compiled<T> {
  pattern: string
  segments: Segment[]
  wildcard: boolean
  value: T
  /** Higher is more specific. Compared lexicographically, segment by segment. */
  rank: number[]
}

const RANK: Record<SegmentKind, number> = { static: 3, param: 2, wildcard: 1 }
const PARAM = /^[a-z][a-z0-9-]*$/i

function compile<T>(entry: RouteEntry<T>): Compiled<T> {
  const { pattern } = entry
  if (!pattern.startsWith('/')) {
    throw new RouterError('E_BAD_PATTERN', `${pattern} must start with '/'`)
  }
  const raw = split(pattern)
  const segments: Segment[] = []
  const names = new Set<string>()
  let wildcard = false

  raw.forEach((piece, index) => {
    if (piece === '*') {
      if (index !== raw.length - 1) {
        throw new RouterError('E_BAD_PATTERN', `${pattern}: '*' has to be the last segment`)
      }
      wildcard = true
      segments.push({ kind: 'wildcard', text: '*' })
      return
    }
    if (piece.startsWith(':')) {
      const name = piece.slice(1)
      if (!PARAM.test(name)) {
        throw new RouterError('E_BAD_PATTERN', `${pattern}: ':${name}' is not a usable param name`)
      }
      if (names.has(name)) {
        throw new RouterError('E_BAD_PATTERN', `${pattern}: ':${name}' appears twice`)
      }
      names.add(name)
      segments.push({ kind: 'param', text: name })
      return
    }
    segments.push({ kind: 'static', text: piece })
  })

  return {
    pattern,
    segments,
    wildcard,
    value: entry.value,
    rank: segments.map((s) => RANK[s.kind]),
  }
}

/** A trailing slash is not a different route. The root is the one path that is only a slash. */
function split(path: string): string[] {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed === '' ? [] : trimmed.slice(1).split('/')
}

/**
 * Static beats a param, a param beats a wildcard, segment by segment — so `/product/new`
 * wins over `/product/:sku`, and `/a/:id` wins over `/a/*`, without either declaring a
 * priority. Two patterns that can match the same path always disagree at some segment, which
 * is why comparing ranks positionally is enough.
 */
function moreSpecific<T>(a: Compiled<T>, b: Compiled<T>): number {
  const length = Math.max(a.rank.length, b.rank.length)
  for (let i = 0; i < length; i++) {
    const left = a.rank[i] ?? 0
    const right = b.rank[i] ?? 0
    if (left !== right) return right - left
  }
  return a.pattern.localeCompare(b.pattern)
}

export function createRouter<T>(entries: readonly RouteEntry<T>[]): Router<T> {
  const compiled = entries.map(compile)
  const seen = new Set<string>()
  for (const route of compiled) {
    // Two patterns that differ only in a param's name match exactly the same paths, so the
    // conflict is on the shape rather than on the text.
    const shape = route.segments.map((s) => (s.kind === 'static' ? s.text : `<${s.kind}>`)).join('/')
    if (seen.has(shape)) {
      throw new RouterError('E_ROUTE_CONFLICT', `${route.pattern} matches the same paths as an earlier route`)
    }
    seen.add(shape)
  }
  compiled.sort(moreSpecific)

  return {
    patterns: compiled.map((r) => r.pattern),
    match(url) {
      const path = typeof url === 'string' ? pathOf(url) : url.pathname
      const parts = split(path)

      for (const route of compiled) {
        const params = matchOne(route, parts)
        if (params) return { value: route.value, pattern: route.pattern, params }
      }
      return null
    },
  }
}

/** A bare path is the common case, and constructing a URL for one needs a base. */
function pathOf(url: string): string {
  return url.includes('://') ? new URL(url).pathname : (url.split('?')[0] as string)
}

function matchOne<T>(route: Compiled<T>, parts: readonly string[]): Record<string, string> | null {
  const fixed = route.wildcard ? route.segments.length - 1 : route.segments.length
  if (route.wildcard ? parts.length < fixed : parts.length !== fixed) return null

  const params: Record<string, string> = {}
  for (let i = 0; i < fixed; i++) {
    const segment = route.segments[i] as Segment
    const part = parts[i] as string
    if (segment.kind === 'static') {
      if (segment.text !== part) return null
      continue
    }
    const decoded = decode(part)
    if (decoded === null) return null
    params[segment.text] = decoded
  }
  if (route.wildcard) {
    const rest = parts.slice(fixed).join('/')
    const decoded = decode(rest)
    if (decoded === null) return null
    params['*'] = decoded
  }
  return params
}

/**
 * A param becomes a cache key component, so a sequence that is not valid percent-encoding
 * has to fail the match rather than reach the key as something the request did not contain.
 */
function decode(value: string): string | null {
  if (!value.includes('%')) return value
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}
