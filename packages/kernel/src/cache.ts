import {
  cacheClassOf,
  flagAxes,
  keyComponents,
  requiresTtl,
  varyOn,
  type CacheClass,
  type EffectSet,
} from '@weftjs/ir'
import type { Ports, RequestFacts } from './ports.ts'
import { deviceOf, localeOf } from './context.ts'

/**
 * Turning an inferred read set into an actual key. Nothing here is written by hand — a key that
 * can be hand-set can drift from what the code reads. Resolved before the render, never after: on
 * a hit there is no render. See `spec/kernel/cache.md`.
 */
export class CacheError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(`${code} — ${message}`)
    this.name = 'CacheError'
    this.code = code
  }
}

/** What a key is derived from: the fragment's identity and the reads the compiler recorded. */
export interface KeyInput {
  /** The fragment's identity: module and export, stable across content changes. */
  id: string
  /** Its content address. A template edit is a different cached thing. */
  version: string
  effects: EffectSet
}

/** The key, its class, what went into it, and one line saying why — which is what `weft why` prints. */
export interface ResolvedKey {
  /** Null when the fragment is uncacheable, which today means it read `opaque`. */
  key: string | null
  class: CacheClass
  /** Read to resolved value, for the reads whose value the key depends on. */
  components: Record<string, string>
  /** Flag to resolved value. An axis partitions the plan; it is still part of the key. */
  axes: Record<string, string>
  vary: string[]
  ttlRequired: boolean
  /** One line saying why the key is what it is. This is what `weft why` prints. */
  reason: string
}

/** Resolves one taint to the value that has to go in the key. `time` is absent: the clock is a TTL, not a key component. */
export async function resolveRead(read: string, facts: RequestFacts, ports: Ports): Promise<string> {
  if (read.startsWith('cookie:')) return ports.session.cookie(facts, read.slice(7)) ?? ''
  if (read.startsWith('header:')) return facts.headers.get(read.slice(7)) ?? ''
  if (read.startsWith('route:')) {
    const key = read.slice(6)
    return facts.params[key] ?? facts.url.searchParams.get(key) ?? ''
  }
  if (read.startsWith('flag:')) return String(await ports.flags.resolve(read.slice(5), facts))
  if (read === 'locale') return localeOf(facts)
  if (read === 'device') return deviceOf(facts)
  if (read === 'identity') return (await ports.session.identity(facts)) ?? ''
  if (read === 'time' || read === 'opaque') return ''
  throw new CacheError(
    'E_UNRESOLVABLE_READ',
    `${read} is tracked by the compiler and cannot be resolved here`,
  )
}

/** Reads to a key, by asking the ports for their values. There is no setter and there never will be. */
export async function resolveKey(input: KeyInput, facts: RequestFacts, ports: Ports): Promise<ResolvedKey> {
  const cls = cacheClassOf(input.effects)
  const vary = varyOn(input.effects)
  const ttlRequired = requiresTtl(input.effects)

  if (input.effects.reads.includes('opaque')) {
    return {
      key: null,
      class: 'private',
      components: {},
      axes: {},
      vary,
      ttlRequired,
      reason: 'uncacheable: ctx.raw() leaves effect tracking, so no key can describe this render',
    }
  }

  const components: Record<string, string> = {}
  for (const read of keyComponents(input.effects)) {
    components[read] = await resolveRead(read, facts, ports)
  }

  const axes: Record<string, string> = {}
  for (const axis of flagAxes(input.effects)) {
    axes[axis] = await resolveRead(`flag:${axis}`, facts, ports)
  }

  const key = await digest(keyMaterial(input, components, axes))
  return {
    key,
    class: cls,
    components,
    axes,
    vary,
    ttlRequired,
    reason: describe(cls, components, axes, ttlRequired),
  }
}

/** The bytes a key is a hash of. Sorted, so it never depends on the order reads were written in. */
export function keyMaterial(
  input: KeyInput,
  components: Record<string, string>,
  axes: Record<string, string>,
): string {
  const parts = [`${input.id}@${input.version}`]
  for (const read of Object.keys(components).sort()) parts.push(`${read}=${components[read]}`)
  for (const axis of Object.keys(axes).sort()) parts.push(`flag:${axis}=${axes[axis]}`)
  return parts.join(' ')
}

const utf8 = new TextEncoder()

async function digest(material: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', utf8.encode(material) as unknown as ArrayBuffer)
  const view = new Uint8Array(bytes).subarray(0, 16)
  let out = ''
  for (const b of view) out += b.toString(16).padStart(2, '0')
  return out
}

function describe(
  cls: CacheClass,
  components: Record<string, string>,
  axes: Record<string, string>,
  ttlRequired: boolean,
): string {
  if (cls === 'static') return 'static: reads nothing, so it resolves at build time'
  const parts: string[] = [cls]
  const keyed = Object.keys(components).sort()
  if (keyed.length) parts.push(`keyed by ${keyed.map((k) => `${k}=${components[k]}`).join(', ')}`)
  const axisNames = Object.keys(axes).sort()
  if (axisNames.length) parts.push(`axes ${axisNames.map((a) => `${a}=${axes[a]}`).join(', ')}`)
  if (ttlRequired) parts.push('needs a TTL')
  return parts.join(' | ')
}

/** What a response may advertise. Checked against the class its reads derive, never trusted. */
export type PolicyClass = 'public' | 'private'

/** What a route declares about holding its response: the class, a TTL, and tags. */
export interface CachePolicy {
  class: PolicyClass
  ttlMs?: number
  staleWhileRevalidateMs?: number
  tags?: string[]
}

/**
 * `Cache-Control` and `Vary`, derived from the same effect signature that produced the key. A
 * private class can never be emitted as public — the one header mistake that turns a caching bug
 * into an identity leak.
 */
export function cacheHeaders(resolved: ResolvedKey, policy?: CachePolicy): Record<string, string> {
  const headers: Record<string, string> = {}
  if (resolved.vary.length) headers.vary = resolved.vary.join(', ')

  if (!policy) {
    headers['cache-control'] = resolved.class === 'private' ? 'private, no-store' : 'no-store'
    return headers
  }
  if (policy.class === 'public' && resolved.class === 'private') {
    throw new CacheError(
      'E_PRIVATE_AS_PUBLIC',
      'a public policy on a fragment classified private would put one user of the site in another one of their caches',
    )
  }
  if (resolved.ttlRequired && policy.ttlMs === undefined) {
    throw new CacheError(
      'E_TTL_REQUIRED',
      'this fragment reads the clock, so a cache policy without a TTL would never expire',
    )
  }

  const directives = [policy.class === 'public' ? 'public' : 'private']
  if (policy.ttlMs !== undefined) directives.push(`max-age=${Math.floor(policy.ttlMs / 1000)}`)
  if (policy.staleWhileRevalidateMs !== undefined) {
    directives.push(`stale-while-revalidate=${Math.floor(policy.staleWhileRevalidateMs / 1000)}`)
  }
  headers['cache-control'] = directives.join(', ')
  return headers
}
