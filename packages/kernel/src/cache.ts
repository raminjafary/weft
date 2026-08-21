import {
  cacheClassOf,
  flagAxes,
  keyComponents,
  requiresTtl,
  varyOn,
  type CacheClass,
  type EffectSet,
} from '@weft/ir'
import type { Ports, RequestFacts } from './ports.ts'
import { deviceOf, localeOf } from './context.ts'

/**
 * Turning an inferred read set into an actual key.
 *
 * This is the piece that makes effect inference load-bearing rather than descriptive. The
 * compiler says a fragment reads `cookie:currency` and `flag:new-cart`; the kernel resolves
 * those two values for this request and hashes them with the fragment's content address.
 * Nothing here is written by hand, which is the entire point: a key that can be hand-set
 * can drift from what the code reads, and that drift is the bug the design exists to remove.
 *
 * The key is resolved *before* the render, never after, because on a hit there is no render.
 */
export class CacheError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(`${code} — ${message}`)
    this.name = 'CacheError'
    this.code = code
  }
}

export interface KeyInput {
  /** The fragment's identity: module and export, stable across content changes. */
  id: string
  /** Its content address. A template edit is a different cached thing. */
  version: string
  effects: EffectSet
}

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

/**
 * Resolves one taint to the value that has to go in the key. `time` is deliberately absent:
 * the clock is a TTL, not a key component, or every second would be its own entry.
 */
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

/**
 * The bytes a key is a hash of. Sorted, because a key that depended on the order somebody
 * happened to write their reads in would miss for no reason.
 */
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

export type PolicyClass = 'public' | 'private'

export interface CachePolicy {
  class: PolicyClass
  ttlMs?: number
  staleWhileRevalidateMs?: number
  tags?: string[]
}

/**
 * `Cache-Control` and `Vary`, derived from the same effect signature that produced the key,
 * so the CDN, the browser and the store agree on cacheability by construction rather than
 * by convention. A private class can never be emitted as public: that is the one header
 * mistake that turns a caching bug into an identity leak.
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
