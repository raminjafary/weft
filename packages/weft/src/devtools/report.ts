import { readdir } from 'node:fs/promises'
import { relative } from 'node:path'
import {
  cacheClassOf,
  explain,
  requiresTtl,
  varyOn,
  type CacheClass,
  type Hole,
  type WireForm,
} from '@weft/ir'
import { requestFacts, resolveKey, type Ports, type ResolvedKey } from '@weft/kernel'
import { factsFrom, why, type Plan, type SlotFacts, type SlotSpec, type WhyReport } from '@weft/plan'
import type { CompiledFragment } from '../compile.ts'
import type { App } from '../serve.ts'

/**
 * What devtools knows, derived from the `App` object and from nothing else.
 *
 * Everything here is already in memory by the time a request is served: the generated plan, the
 * compiled fragments, the intent manifest and the asset table. Nothing in this file compiles,
 * renders, walks the file tree for routes or re-infers an effect set, because a devtools page
 * that computed its own answer would be a second answer — and the day the two disagreed, the
 * one you were looking at would be the wrong one.
 *
 * The same argument decides where the numbers come from. Bytes are read off assets that exist,
 * key reasons come from `resolveKey`, and the DAG comes from `@weft/plan`'s `why`. A number
 * nobody measured is not printed.
 */
export class DevtoolsError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(`${code} — ${message}`)
    this.name = 'DevtoolsError'
    this.code = code
  }
}

/**
 * Slot facts, keyed by the compiler's own `module#export`.
 *
 * Deliberately the same call `generateRoutes` makes over the same fragments, so the plan the
 * page shows was validated against exactly the facts the page prints beside it.
 */
function factsOf(app: App): Record<string, SlotFacts> {
  return factsFrom(
    Object.values(app.compiled.fragments).map((fragment) => ({ fragments: [{ entry: fragment.entry }] })),
  )
}

function byCompilerId(app: App): Map<string, CompiledFragment> {
  return new Map(Object.values(app.compiled.fragments).map((fragment) => [fragment.entry.id, fragment]))
}

function assetBytes(body: string | Uint8Array): number {
  return typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength
}

function templateBytes(fragment: CompiledFragment): number {
  return fragment.templates.reduce(
    (total, template) => total + template.segments.reduce((sum, segment) => sum + segment.length, 0),
    0,
  )
}

/**
 * The sealed markup a page carries: every template each of its slots needs, counted once.
 *
 * Deduplicated by version rather than by fragment, because a component rendered by two slots is
 * one template on the wire and counting it twice would overstate the page by exactly the thing
 * the design exists to share.
 */
function markupBytes(app: App, ids: readonly string[]): number {
  const byId = byCompilerId(app)
  const counted = new Set<string>()
  let total = 0
  for (const id of new Set(ids)) {
    const fragment = byId.get(id)
    if (!fragment) continue
    for (const template of fragment.templates) {
      if (counted.has(template.version)) continue
      counted.add(template.version)
      total += template.segments.reduce((sum, segment) => sum + segment.length, 0)
    }
  }
  return total
}

export interface SlotRow {
  /** Placement, as the generated plan states it. */
  spec: SlotSpec
  /** Reads, forms and identity, as the compiler inferred them. Absent for a slot with no fragment. */
  facts?: SlotFacts
  /** The `.tsx` it was compiled from, project-relative. */
  file?: string
}

export interface LiveRow {
  slot: string
  /** The key the framework records the base render under. Not a store entry an intent can name. */
  key: string
  tags: string[]
  file: string
}

export interface RouteReport {
  pattern: string
  plan: Plan
  slots: SlotRow[]
  live: LiveRow[]
  /** The stylesheets this page links, project-relative. */
  css: string[]
  stylesheet: string
  /** Null when the href is not in the asset table, which would be a bug worth seeing. */
  stylesheetBytes: number | null
  markupBytes: number
}

export function routeReport(app: App): RouteReport[] {
  const facts = factsOf(app)
  const byId = byCompilerId(app)
  return app.routes.map((route) => {
    const stylesheet = app.assets.pageCss(route.pattern)
    const asset = app.assets.files.get(stylesheet)
    return {
      pattern: route.pattern,
      plan: route.plan,
      slots: route.plan.slots.map((spec) => {
        const fact = spec.fragment ? facts[spec.fragment] : undefined
        const fragment = spec.fragment ? byId.get(spec.fragment) : undefined
        return {
          spec,
          ...(fact ? { facts: fact } : {}),
          ...(fragment ? { file: fragment.file } : {}),
        }
      }),
      live: Object.entries(route.live).map(([slot, live]) => ({
        slot,
        key: live.key,
        tags: live.tags,
        file: live.fragment.file,
      })),
      css: route.css.map((file) => relative(app.config.root, file)),
      stylesheet,
      stylesheetBytes: asset ? assetBytes(asset.body) : null,
      markupBytes: markupBytes(
        app,
        route.plan.slots.map((slot) => slot.fragment ?? ''),
      ),
    }
  })
}

export interface FragmentReport {
  /** The logical name: `layout`, `route:/blog/:slug`, `fragment:card`. */
  name: string
  file: string
  /** `module#export`, stable across content changes — what a plan names. */
  id: string
  /** The content address. A template edit is a different sealed thing. */
  version: string
  class: CacheClass
  reads: string[]
  vary: string[]
  ttlRequired: boolean
  forms: WireForm[]
  explanation: string
  holes: Hole[]
  templates: string[]
  bytes: number
}

export function fragmentReport(app: App): FragmentReport[] {
  return Object.entries(app.compiled.fragments).map(([name, fragment]) => ({
    name,
    file: fragment.file,
    id: fragment.entry.id,
    version: fragment.entry.version,
    class: cacheClassOf(fragment.entry.effects),
    reads: fragment.entry.effects.reads,
    vary: varyOn(fragment.entry.effects),
    ttlRequired: requiresTtl(fragment.entry.effects),
    forms: fragment.entry.forms,
    explanation: explain(fragment.entry.effects),
    holes: fragment.entry.holes,
    templates: fragment.templates.map((template) => template.version),
    bytes: templateBytes(fragment),
  }))
}

export interface AssetRow {
  href: string
  bytes: number
  immutable: boolean
  type: string
}

/**
 * A module tree is served from source and transformed on the way out — types stripped, bare
 * specifiers rewritten — so what the browser receives is not the file on disk. There is no
 * measured byte count for it here and none is invented: the count of files is what is known.
 */
export interface TreeRow {
  prefix: string
  dir: string
  ext: string
  files: number
}

export interface ByteReport {
  /** False in dev, where a URL carries no digest and therefore cannot be cached at all. */
  revved: boolean
  assets: AssetRow[]
  totalBytes: number
  trees: TreeRow[]
  boot: string
  app?: string
  routes: {
    pattern: string
    markupBytes: number
    stylesheet: string
    stylesheetBytes: number | null
  }[]
}

export async function byteReport(app: App): Promise<ByteReport> {
  const assets: AssetRow[] = [...app.assets.files]
    .map(([href, asset]) => ({
      href,
      bytes: assetBytes(asset.body),
      immutable: asset.immutable,
      type: asset.type,
    }))
    .sort((a, b) => b.bytes - a.bytes)

  const trees: TreeRow[] = []
  for (const [prefix, tree] of app.assets.trees) {
    const names = await readdir(tree.dir).catch((): string[] => [])
    trees.push({
      prefix,
      dir: tree.dir,
      ext: tree.ext,
      files: names.filter((name) => name.endsWith(tree.ext)).length,
    })
  }

  return {
    revved: app.assets.revved,
    assets,
    totalBytes: assets.reduce((sum, asset) => sum + asset.bytes, 0),
    trees,
    boot: app.assets.boot,
    ...(app.assets.app ? { app: app.assets.app } : {}),
    routes: routeReport(app).map((route) => ({
      pattern: route.pattern,
      markupBytes: route.markupBytes,
      stylesheet: route.stylesheet,
      stylesheetBytes: route.stylesheetBytes,
    })),
  }
}

/** The params a pattern cannot be resolved without. A trailing `*` is one of them. */
export function paramsOf(pattern: string): string[] {
  return pattern
    .split('/')
    .flatMap((segment) => (segment.startsWith(':') ? [segment.slice(1)] : segment === '*' ? ['*'] : []))
}

function concrete(pattern: string, params: Record<string, string>): string {
  const path = pattern
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) return params[segment.slice(1)] ?? segment
      if (segment === '*') return params['*'] ?? ''
      return segment
    })
    .join('/')
  return path || '/'
}

export interface WhyPage {
  pattern: string
  plan: Plan
  report: WhyReport
  /** Empty when the route needs params this request did not supply. */
  resolved: Record<string, ResolvedKey>
  /** A slot whose key could not be resolved, with the error that says why. */
  refused: { slot: string; message: string }[]
  /** Params the pattern has, and the ones this request left unanswered. */
  wants: string[]
  missing: string[]
  params: Record<string, string>
  /** The concrete path the keys were resolved against. */
  at: string
}

/**
 * `weft why`, for a route, against this request.
 *
 * The DAG, the waves, the critical path and the budget diagnostics are `@weft/plan`'s `why` —
 * the same function and the same input the CLI has, so the page cannot say something the
 * command would not. What the page adds is the half the CLI has no request for: the cache key
 * each slot resolves to *now*, and the one line from `resolveKey` saying which read put
 * `identity` in it.
 *
 * A pattern with params has no key until somebody says what they are. Rather than resolve
 * against an empty string and print a key that describes no page anyone will ever request,
 * the params are named and the keys section is refused.
 */
export async function whyPage(
  app: App,
  pattern: string,
  query: URLSearchParams,
  headers: Headers,
  ports: Ports,
): Promise<WhyPage> {
  const route = app.routes.find((candidate) => candidate.pattern === pattern)
  if (!route) {
    throw new DevtoolsError(
      'E_NO_SUCH_ROUTE',
      `${pattern} is not a route in this application. It has: ${app.routes
        .map((candidate) => candidate.pattern)
        .join(', ')}`,
    )
  }

  const facts = factsOf(app)
  const wants = paramsOf(pattern)
  const params: Record<string, string> = {}
  for (const name of wants) {
    const value = query.get(name)
    if (value !== null && value !== '') params[name] = value
  }
  const missing = wants.filter((name) => params[name] === undefined)
  const at = concrete(pattern, params)

  const resolved: Record<string, ResolvedKey> = {}
  const refused: { slot: string; message: string }[] = []
  if (!missing.length) {
    const url = new URL(at, 'http://weft.local')
    // Anything else on the devtools URL is forwarded, because `ctx.query()` is a `route:` read
    // like any other and a key that ignored it would be a key for a different request.
    for (const [name, value] of query) {
      if (name !== 'route' && !wants.includes(name)) url.searchParams.set(name, value)
    }
    // The caller's own headers, so `identity` and every `cookie:` read resolve to what *this*
    // browser would get. A key resolved against an empty session answers nobody's question.
    const request = requestFacts(new Request(url, { headers }), params)
    for (const slot of route.plan.slots) {
      const fact = slot.fragment ? facts[slot.fragment] : undefined
      if (!fact) continue
      try {
        resolved[slot.name] = await resolveKey(
          { id: fact.id, version: fact.version, effects: fact.effects },
          request,
          ports,
        )
      } catch (error) {
        refused.push({ slot: slot.name, message: (error as Error).message })
      }
    }
  }

  return {
    pattern,
    plan: route.plan,
    report: why({
      plan: route.plan,
      facts,
      ...(Object.keys(resolved).length ? { resolved } : {}),
    }),
    resolved,
    refused,
    wants,
    missing,
    params,
    at,
  }
}
