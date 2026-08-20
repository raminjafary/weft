import type { EffectSet } from './template-ir.ts'

export type CacheClass = 'static' | 'shared' | 'private'

/**
 * Everything about cacheability is derived from what a render read. Nothing here is
 * declared by an author, which is the point: a cache class that can be asserted can be
 * asserted wrongly.
 */
export function cacheClassOf(effects: EffectSet): CacheClass {
  if (effects.reads.length === 0 && effects.envelope.length === 0) return 'static'
  if (effects.reads.some(isPrivate)) return 'private'
  return 'shared'
}

/** Identity and the opaque escape hatch are the only reads that force a private class. */
function isPrivate(read: string): boolean {
  return read === 'identity' || read === 'opaque'
}

/** Reading the clock forces a TTL: a cache policy without one would never expire. */
export function requiresTtl(effects: EffectSet): boolean {
  return effects.reads.includes('time')
}

/** A shared response keyed by a request value has to say so, or a CDN will serve it to everyone. */
export function varyOn(effects: EffectSet): string[] {
  const headers = new Set<string>()
  for (const read of effects.reads) {
    if (read.startsWith('cookie:')) headers.add('Cookie')
    else if (read.startsWith('header:')) headers.add(header(read.slice('header:'.length)))
    else if (read === 'locale') headers.add('Accept-Language')
  }
  return [...headers].sort()
}

function header(name: string): string {
  return name
    .split('-')
    .map((part) => (part ? part[0]?.toUpperCase() + part.slice(1) : part))
    .join('-')
}

/**
 * The reads a cache key has to include the *values* of. A flag is an axis rather than a
 * key component — the losing branch is unreachable, not cached separately — and time is a
 * TTL rather than a key.
 */
export function keyComponents(effects: EffectSet): string[] {
  return effects.reads.filter((read) => read !== 'time' && !read.startsWith('flag:')).sort()
}

/** Flag axes partition the graph, so they are listed separately from the key. */
export function flagAxes(effects: EffectSet): string[] {
  return effects.reads
    .filter((read) => read.startsWith('flag:'))
    .map((read) => read.slice('flag:'.length))
    .sort()
}

export function isStatic(effects: EffectSet): boolean {
  return cacheClassOf(effects) === 'static'
}

/** A one-line account of why a fragment is cacheable the way it is. */
export function explain(effects: EffectSet): string {
  const cls = cacheClassOf(effects)
  if (cls === 'static') return 'static — reads nothing, so it resolves at build time'
  const parts = [`${cls} — reads ${effects.reads.join(', ')}`]
  const axes = flagAxes(effects)
  if (axes.length) parts.push(`flag axes ${axes.join(', ')}`)
  const vary = varyOn(effects)
  if (vary.length) parts.push(`Vary: ${vary.join(', ')}`)
  if (requiresTtl(effects)) parts.push('needs a TTL')
  return parts.join(' · ')
}
