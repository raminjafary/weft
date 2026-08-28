import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { loaderReads } from '@weftjs/compiler'
import {
  baseRenderId,
  clientOwned,
  clientView,
  readsOf,
  render,
  unionEffects,
  type DerivedExpr,
  type Values,
} from '@weftjs/ir'
import {
  createRouter,
  recordBase,
  type KernelSlot,
  type Ports,
  type RegionSpec,
  type RenderContext,
  type RouteEntry,
  type RouteResolver,
  type StorePort,
} from '@weftjs/kernel'
import {
  every,
  factsFrom,
  guard as guardSpec,
  lowerPlan,
  plan as buildPlan,
  region as regionSpec,
  regionSpecOf,
  shell as shellSpec,
  slot as slotSpec,
  type Plan,
  type RegionBuilder,
  type RouteBindings,
  type SlotBinding,
  type SlotFacts,
} from '@weftjs/plan'
import { composedIn, slotHoles, type CompiledApp, type CompiledFragment } from './compile.ts'
import { withServices } from './context.ts'
import type { Decisions, Recorder, SlotDecision } from './profile.ts'
import { chainFor, type Discovered, type DiscoveredRoute } from './convention.ts'
import type {
  BudgetDeclaration,
  CacheDeclaration,
  RegionDeclaration,
  RouteModule,
  SlotDeclaration,
} from './route.ts'
import { staticVerdict, type StaticVerdict } from './static.ts'
import type { ExceedPolicy } from './types.ts'
import type { ResolvedConfig } from './config.ts'

const utf8 = new TextEncoder()

/**
 * The generated plan: a route file and its declaration become a `Plan` and a `RouteBindings`.
 * Nothing here invents a fact — cache classes, read sets and escape decisions come from the
 * compiler, placement from the declaration, and the plan is validated against the former.
 */
export interface GeneratedRoute {
  pattern: string
  plan: Plan
  entry: RouteEntry<RouteResolver>
  module: RouteModule
  /** Slots this route can refresh over the channel, by slot name. */
  live: Record<string, LiveSlot>
  /**
   * Every region of this route, live or not, by slot name. `live` gates a *refresh*; staging a
   * route needs every region regardless, because the reader is about to see the whole page.
   */
  regions: Record<string, LiveSlot>
  /**
   * Regions of this route that render on another deployment, by slot name. Carried on the route
   * because a region is composed on three paths, and all three have to reach the same deployment
   * with the same budget and contract. Derived by the plan layer's `regionSpecOf`.
   */
  remote: Record<string, RegionSpec>
  /**
   * The shell values this route offers its regions, resolved for a set of params — read from the
   * same `shellValues` the document rendered with. See `spec/kernel/composition.md`.
   */
  exposed(params: Record<string, string>): Promise<Record<string, string>>
  /** The document this route is rendered into. Two routes share regions only if they share it. */
  shell: { id: string; version: string }
  /** The title, resolved for a set of params, so a staged route can carry the one it will show. */
  titleFor(params: Record<string, string>): string
  /** Every layout hole, in document order. */
  holes: string[]
  /**
   * Whether every byte of this document is decided before a request exists, and if not, why not.
   * Structural only — `prerender` settles the half that needs measurement.
   */
  static: StaticVerdict
  /**
   * Whether this route answers conditional requests, which means the front door holds its response
   * back until it is complete and digests it. Declared by the route, refused where it contradicts
   * the plan's own delivery — see `E_ETAG_STREAMS`.
   */
  etag: boolean
  /** Stylesheets this route links, in cascade order: the page's own, then every fragment it renders. */
  css: string[]
}

/** A region the framework can render again later: its fragment, its loader, and its cache tags. */
export interface LiveSlot {
  fragment: CompiledFragment
  load: (ctx: RenderContext, params: Record<string, string>) => Promise<Values>
  key: string
  tags: string[]
}

/** Every route, the compiler's facts, and which holes the documents left. */
export interface Generated {
  routes: GeneratedRoute[]
  facts: Record<string, SlotFacts>
  /** Which layout hole each route fills with what, for `weft build`'s report. */
  layoutSlots: string[]
}

/** A generation refusal, naming the file rather than the mechanism. */
export class GenerateError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(`${code} — ${message}`)
    this.name = 'GenerateError'
    this.code = code
  }
}

/** The layout values the framework always supplies. A layout may use any subset of these. */
const STANDARD = [
  'title',
  'description',
  'css',
  'runtime',
  'preload',
  'canonical',
  'brand',
  'nav',
  'prelude',
] as const

async function loadModule(file: string | undefined): Promise<RouteModule> {
  if (!file) return {}
  const loaded = (await import(pathToFileURL(file).href)) as { default?: RouteModule }
  if (!loaded.default) {
    throw new GenerateError(
      'E_NO_DEFAULT_ROUTE',
      `${file} has to default-export defineRoute({…}). A data file that exports nothing declares nothing`,
    )
  }
  return loaded.default
}

function labelOf(pattern: string): string {
  if (pattern === '/') return 'Home'
  const last = pattern.split('/').findLast(Boolean) as string
  return last.replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase())
}

/** Every route a nav can link to: one with a param has no single URL to point at. */
export function navOf(discovered: Discovered): { href: string; label: string }[] {
  return discovered.routes
    .filter((r) => !r.pattern.includes(':') && !r.pattern.includes('*'))
    .map((r) => ({ href: r.pattern, label: labelOf(r.pattern) }))
    .sort((a, b) => (a.href === '/' ? -1 : b.href === '/' ? 1 : a.label.localeCompare(b.label)))
}

function cacheOf(
  spec: CacheDeclaration | undefined,
): Parameters<ReturnType<typeof slotSpec>['cache']> | null {
  if (!spec) return null
  return [
    spec.class,
    {
      ...(spec.ttl !== undefined ? { ttl: spec.ttl } : {}),
      ...(spec.swr !== undefined ? { swr: spec.swr } : {}),
      ...(spec.tags ? { tags: spec.tags } : {}),
      ...(spec.consistency ? { consistency: spec.consistency } : {}),
    },
  ]
}

/**
 * The placement a slot and a region share: everything except where the render happens. A profile
 * may overrule only delivery — it cannot move a fragment, change a cache class or touch a key. See
 * `spec/plan/profile.md`.
 */
interface Placeable {
  stream(options?: { prio?: number }): unknown
  buffered(): unknown
  cache(...args: Parameters<ReturnType<typeof slotSpec>['cache']>): unknown
  incremental(): unknown
  speculate(mode?: boolean | 'profile'): unknown
  budget(spec: BudgetDeclaration): unknown
  refresh(everyMs: number): unknown
  form(spec: NonNullable<SlotDeclaration['form']>): unknown
  needs(...slots: string[]): unknown
  executor?(target: string): unknown
}

function applyPlacement(builder: Placeable, declaration: SlotDeclaration, decided?: SlotDecision): void {
  const stream = declaration.stream
  if (decided?.delivery === 'stream') builder.stream(decided.prio === undefined ? {} : { prio: decided.prio })
  else if (decided?.delivery === 'buffered') builder.buffered()
  else if (stream === false) builder.buffered()
  else if (typeof stream === 'object') builder.stream(stream.prio === undefined ? {} : { prio: stream.prio })
  else if (stream === true) builder.stream()
  else builder.buffered()

  const cache = cacheOf(declaration.cache)
  if (cache) builder.cache(...cache)
  if (declaration.incremental) builder.incremental()
  // A region has no `executor` method by construction and generateOne refuses the combination by
  // name before it gets here, so this cannot silently drop one.
  if (declaration.executor) builder.executor?.(declaration.executor)
  if (declaration.budget) builder.budget(declaration.budget)
  if (declaration.refresh !== undefined) builder.refresh(every(declaration.refresh))
  if (declaration.speculate) builder.speculate(declaration.speculate === 'profile' ? 'profile' : true)
  if (declaration.form) builder.form(declaration.form)
  if (declaration.needs?.length) builder.needs(...declaration.needs)
}

/**
 * A region, as the plan layer's builder. The one thing not transcribed is where it runs — that
 * comes from `weft.config.ts`. See `spec/kernel/composition.md`.
 */
function regionOf(name: string, region: RegionDeclaration): RegionBuilder {
  const builder = regionSpec(name)
  if (region.remote) {
    builder.remote(typeof region.remote === 'object' ? region.remote : undefined)
  } else {
    builder.local()
  }
  if (region.fallback) builder.fallback(region.fallback)
  if (region.optional) builder.optional()
  if (region.csp) builder.csp(region.csp)
  if (region.consumes?.length) builder.consumes(...region.consumes)
  if (region.critical) builder.critical()
  return builder
}

/** The document a route is wrapped in. Named layouts exist because a page with a different shape
 * needs different slot holes, and the plan is generated per route. */
function layoutFor(compiled: CompiledApp, name: string | undefined, where: string): CompiledFragment {
  const found = name ? compiled.fragments[`layout:${name}`] : compiled.fragments.layout
  if (!found) {
    throw new GenerateError(
      'E_NO_SUCH_LAYOUT',
      name
        ? `${where} names layout '${name}', but app/layouts/${name}.tsx does not exist`
        : `${where} has no layout and the framework's own could not be compiled`,
    )
  }
  return found
}

/**
 * The nested layouts a route is wrapped in, outermost first. The chain comes from the file tree, so
 * nothing declares it and nothing can declare it differently.
 */
function nestedFor(compiled: CompiledApp, discovered: Discovered, pattern: string): CompiledFragment[] {
  return chainFor(pattern, discovered.nested).map((entry) => {
    const found = compiled.fragments[`nested:${entry.scope}`]
    if (!found) {
      throw new GenerateError(
        'E_NO_SUCH_LAYOUT',
        `${pattern} is under ${entry.scope}, whose layout.tsx could not be compiled`,
      )
    }
    return found
  })
}

/** Every binding a derived expression reads, however deep the tree goes. */
function refsIn(expr: DerivedExpr): string[] {
  switch (expr.k) {
    case 'ref':
      return [expr.id]
    case 'un':
      return refsIn(expr.a)
    case 'bin':
      return [...refsIn(expr.a), ...refsIn(expr.b)]
    case 'cond':
      return [...refsIn(expr.a), ...refsIn(expr.b), ...refsIn(expr.c)]
    default:
      return []
  }
}

/** The hole every link in a chain fills: where the thing this document wraps goes. */
const NESTS_AT = 'body'

/** A chain of layouts, as a message names it: the files, outermost first. */
function documentOf(layers: readonly CompiledFragment[]): string {
  return layers.map((fragment) => fragment.file).join(' > ')
}

/**
 * Every boundary a chain leaves, in document order. Not a concatenation: a nested layout's holes
 * appear where the layout does, so header/body/footer wrapping main/aside leaves header, main,
 * aside, footer — and the stream sends them in that order.
 */
function chainHoles(layers: readonly CompiledFragment[]): string[] {
  const walk = (index: number): string[] => {
    const own = slotHoles(layers[index] as CompiledFragment)
    if (index === layers.length - 1) return own
    const at = own.indexOf(NESTS_AT)
    return [...own.slice(0, at), ...walk(index + 1), ...own.slice(at + 1)]
  }
  return walk(0)
}

/**
 * A chain has to be a chain: every layer but the innermost needs a hole for the next one. Checked
 * here rather than in the plan layer, which sees fragment ids and not files.
 */
function checkChain(layers: readonly CompiledFragment[], pattern: string): void {
  for (let i = 0; i < layers.length - 1; i++) {
    const layer = layers[i] as CompiledFragment
    if (slotHoles(layer).includes(NESTS_AT)) continue
    throw new GenerateError(
      'E_NO_NESTING_SLOT',
      `${layer.file} wraps ${(layers[i + 1] as CompiledFragment).file} on ${pattern}, and has no ` +
        `<slot name="${NESTS_AT}"> to put it in`,
    )
  }
  const seen = new Map<string, string>()
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i] as CompiledFragment
    for (const hole of slotHoles(layer)) {
      // The hole a link fills is not a boundary: it is where the next layout goes.
      if (hole === NESTS_AT && i < layers.length - 1) continue
      const held = seen.get(hole)
      if (held) {
        throw new GenerateError(
          'E_DUPLICATE_LAYOUT_HOLE',
          `${pattern}: ${held} and ${layer.file} both leave a hole '${hole}'. One region cannot be ` +
            `in two places, so a nested layout has to name its holes differently from the one it is inside`,
        )
      }
      seen.set(hole, layer.file)
    }
  }
}

/**
 * Which fragment renders a slot, given what its declaration named: `html` goes through the one
 * unescaped fragment, a name means `app/fragments/<name>.tsx`, neither means the global
 * `app/slots/<name>.tsx`, and none of the three is a build error naming all three ways out.
 */
function fragmentFor(
  compiled: CompiledApp,
  markup: CompiledFragment,
  declaration: SlotDeclaration,
  where: string,
  slot = 'body',
): CompiledFragment {
  const found = declaration.fragment
    ? compiled.fragments[`fragment:${declaration.fragment}`]
    : declaration.html !== undefined
      ? markup
      : compiled.fragments[`slot:${slot}`]
  if (!found) {
    throw new GenerateError(
      'E_NO_SUCH_FRAGMENT',
      `${where} slot '${slot}': ${
        declaration.fragment
          ? `app/fragments/${declaration.fragment}.tsx does not exist`
          : `nothing renders it. Give it html, a fragment, or write app/slots/${slot}.tsx`
      }`,
    )
  }
  return found
}

/**
 * A slot's values, and the context its loader is given. `withServices` adds what the deployment
 * bound without touching the kernel's own read-tracking context — a loader is a front-door concept.
 */
function valuesOf(
  declaration: SlotDeclaration,
  ports: Ports,
): (ctx: RenderContext, params: Record<string, string>) => Promise<Values> {
  if (declaration.html !== undefined) {
    const html = declaration.html
    return async (ctx, params) => {
      const text = typeof html === 'function' ? await html(ctx, params) : html
      return { html: text } as unknown as Values
    }
  }
  if (declaration.load) {
    const load = declaration.load
    return async (ctx, params) => (await load(withServices(ctx, ports), params)) as Values
  }
  return async () => ({}) as Values
}

/** The adopt payload, derived rather than written, from what the compiler put in the template. */
export interface AdoptOptions {
  /** Extra value names beyond the ones a client-owned derived expression is seen to read. */
  expose?: readonly string[]
  /** Refreshable over the channel, which is what tells the client to connect on load. */
  live?: boolean
  /** What the client queries to find the region. Defaults to the slot's own wrapper. */
  selector?: string
  /**
   * `refresh(everyMs, { when })` from the plan: the design's stated fallback for push invalidation
   * across a tier boundary. See `spec/kernel/composition.md`.
   */
  refresh?: { everyMs: number; when?: readonly string[] }
}

/**
 * The adopt payload: everything the client needs to bind a rendered region, and nothing else.
 * Exported because a page whose subject *is* adoption has to be able to show you the real one.
 */
/** The scroll restore, as an inline script rendered at the end of the body. See `spec/client/navigation.md`. */
const SCROLL_PRELUDE =
  '<script>(function(){try{' +
  'var k="weft:scroll:"+location.pathname,v=sessionStorage.getItem(k);if(!v)return;' +
  'sessionStorage.removeItem(k);var y=+v;if(!(y>0))return;' +
  'var land=function(){window.scrollTo({top:y,behavior:"instant"})};land();' +
  // Recorded so a readout can say when the restore happened.
  'window.__weftScrollAt=performance.now();' +
  // A re-land: a streamed slot or a late-loading image can change the height after the first
  // attempt. Skipped if the reader has since scrolled themselves.
  'if(document.readyState!=="complete")addEventListener("load",function(){' +
  'if(Math.abs(window.scrollY-y)>4&&window.scrollY<4)land()},{once:true})' +
  '}catch(e){}})()</script>'

/**
 * The payload that binds a slot's template to the markup this render produced, or null for a slot
 * nothing on the client could act on. See `spec/client/adoption.md`.
 */
export function adoptScript(
  slot: string,
  fragment: CompiledFragment,
  values: Values,
  options: AdoptOptions = {},
): string | null {
  const { entry } = fragment
  const live = options.live ?? false
  const expose = options.expose ?? []
  // Every template, not only the entry: a row's own wiring makes the region interactive too.
  const nested = fragment.templates.filter((template) => template.version !== entry.version)
  // Whether anything can actually drive the wiring, not whether it exists. See
  // `spec/client/adoption.md`.
  const hasSignals = fragment.templates.some((t) => t.signals.length > 0)
  const hasEvents = fragment.templates.some((t) => t.wiring.some((w) => w.op === 'event'))
  // A static slot ships nothing.
  if (!hasSignals && !hasEvents && !live && expose.length === 0) return null

  const intents: Record<string, string> = {}
  for (const template of fragment.templates) {
    for (const wiring of template.wiring) {
      if (wiring.op === 'event' && wiring.intent) intents[wiring.intent] = wiring.event ?? 'input'
    }
  }
  const record = values as unknown as Record<string, unknown>
  const exposed: Record<string, unknown> = {}
  for (const name of [...neededInBrowser(fragment), ...expose]) {
    if (name in record) exposed[name] = record[name]
  }

  const payload = {
    slot,
    selector: options.selector ?? `[data-weft-slot="${slot}"]`,
    template: clientView(entry),
    /** The row and component templates this region needs, so a row's own wiring is adoptable. */
    templates: nested.map(clientView),
    base: baseRenderId(entry, values),
    signals: entry.signals.map((declaration) => ({ id: declaration.id, init: declaration.init })),
    values: exposed,
    intents,
    live,
    // Only for a slot that can actually be refreshed.
    ...(live && options.refresh ? { refresh: options.refresh } : {}),
  }
  return `<script type="application/json" data-weft="adopt">${JSON.stringify(payload).replace(
    /</g,
    '\\u003c',
  )}</script>`
}

/** Which values the browser needs, derived rather than declared. See `spec/client/adoption.md`. */
function neededInBrowser(fragment: CompiledFragment): string[] {
  const { entry } = fragment
  if (!entry.derived.length) return []
  const owned = clientOwned(entry.derived, entry.signals)
  const known = new Set<string>([...owned, ...entry.signals.map((signal) => signal.id)])
  const needed = new Set<string>()
  for (const decl of entry.derived) {
    if (!owned.has(decl.id)) continue
    for (const read of readsOf(decl.expr)) {
      if (!known.has(read)) needed.add(read)
    }
  }
  return [...needed]
}

/**
 * Every slot's bytes get a wrapper element: adoption addresses nodes by index from a root, and the
 * wrapper is also what a channel delta and an HTML fallback target by name.
 */
/** The params a slot's cache identity has to carry, as a stable string. Sorted, so key order is stable. */
function paramsOf(params: Record<string, string>): string {
  const entries = Object.entries(params).sort(([a], [b]) => a.localeCompare(b))
  return entries.length ? `?${entries.map(([k, v]) => `${k}=${v}`).join('&')}` : ''
}

function wrapSlot(
  slot: KernelSlot,
  name: string,
  pattern: string,
  params: Record<string, string>,
  declared: readonly string[],
  fragment: CompiledFragment | undefined,
  captured: WeakMap<object, Map<string, Values>>,
  expose: readonly string[],
  live: boolean,
  store: StorePort,
  refresh: { everyMs: number; when?: readonly string[] } | undefined,
  recorder?: Recorder,
): KernelSlot {
  const open = utf8.encode(`<div data-weft-slot="${name}">`)
  return {
    ...slot,
    // The cached thing is a slot on a route, not a fragment: id scoped to route and slot, params
    // folded into the identity. See `spec/kernel/cache.md`.
    id: `${slot.id}@${pattern}:${name}${paramsOf(params)}`,
    // What the fragment reads, and what the route's own declaration reads — a query string's
    // reads, not folded into the id because it is unbounded. See `spec/kernel/cache.md`.
    effects: declared.length
      ? unionEffects([slot.effects, { reads: [...declared], writes: [], envelope: [], residency: 'either' }])
      : slot.effects,
    render: async (ctx) => {
      // Where a profile's numbers come from: the one place that holds both the route and the slot.
      const at = recorder ? performance.now() : 0
      const bytes = await slot.render(ctx)
      recorder?.render(pattern, name, performance.now() - at, bytes.length)
      const values = captured.get(ctx as unknown as object)?.get(name)
      // A live slot records the render the client is about to be shown, so the first refresh can
      // already be a delta. See `spec/kernel/surgical.md`.
      if (live && fragment && values) await recordBase(store, fragment.entry, values)
      // A remote region ships no adopt payload from here: adoption binds a template this process
      // compiled, and a region's templates came from another deployment.
      const script =
        fragment && values
          ? adoptScript(name, fragment, values, {
              expose,
              live,
              ...(refresh ? { refresh } : {}),
            })
          : null
      const tail = utf8.encode(script ? `</div>${script}` : '</div>')
      const out = new Uint8Array(open.length + bytes.length + tail.length)
      out.set(open, 0)
      out.set(bytes, open.length)
      out.set(tail, open.length + bytes.length)
      return out
    },
  }
}

/** What generation needs: the file tree, the compiled templates, the ports, and the late bindings. */
export interface GenerateOptions {
  discovered: Discovered
  compiled: CompiledApp
  config: ResolvedConfig
  /** The one stylesheet a page links, resolved when the page renders — the href does not exist yet at generation time. */
  styleHref(pattern: string): string
  /** A fragment file's colocated stylesheets, in cascade order: global `.css`, then `.scoped.css`. */
  styleOf(file: string): readonly string[]
  /** Where a live slot's base render is recorded, so its first refresh can be a delta. */
  store: StorePort
  /** Every cache tag some intent writes. See `StaticInput.written`. */
  written?: ReadonlySet<string>
  /** What this deployment bound. A loader is handed the services half of it. */
  ports: Ports
  /** What a recording decided about delivery. Placement stays the convention's; a profile decides
   * only whether a region is worth arriving separately. */
  profile?: Decisions
  /** Where a render's cost is recorded, when this process was asked to record one. */
  recorder?: Recorder
  /** The client entry the layout loads. Also a digest-bearing URL, so also resolved late. */
  runtime(): string
  /** `<link rel="modulepreload">` for every module this page will fetch. See `spec/kernel/static.md`. */
  preload(): string
  /** `<link rel="canonical">` for this page, or nothing without an origin. See `spec/kernel/static.md`. */
  canonical(pattern: string, params: Record<string, string>): string
  brand: string
}

/** The convention into plans. The two hundred lines of wiring per application that became one file. */
export async function generateRoutes(options: GenerateOptions): Promise<Generated> {
  const { compiled, discovered, config } = options
  const markup = compiled.fragments.markup as CompiledFragment
  const facts = factsFrom(
    Object.values(compiled.fragments).map((fragment) => ({ fragments: [{ entry: fragment.entry }] })),
  )
  const nav = config.nav ?? navOf(discovered)
  const routes: GeneratedRoute[] = []

  for (const route of discovered.routes) {
    routes.push(
      await generateOne(route, {
        ...options,
        markup,
        facts,
        nav,
        maxConcurrency: config.maxConcurrency,
      }),
    )
  }

  return { routes, facts, layoutSlots: [...new Set(routes.flatMap((r) => r.plan.slots.map((s) => s.name)))] }
}

interface OneOptions extends GenerateOptions {
  markup: CompiledFragment
  facts: Record<string, SlotFacts>
  nav: { href: string; label: string }[]
  maxConcurrency: number
}

/**
 * The reads a route's declaration file performs, resolved once when the route is generated — a
 * property of the file rather than of the request. See `spec/kernel/cache.md`.
 */
async function reads(file: string | undefined): Promise<readonly string[]> {
  if (!file) return []
  return loaderReads(file, await readFile(file, 'utf8'))
}

async function generateOne(route: DiscoveredRoute, options: OneOptions): Promise<GeneratedRoute> {
  const { compiled, markup, facts, nav, discovered } = options
  const module_ = await loadModule(route.data)
  const declared = await reads(route.data)
  const layout = layoutFor(compiled, module_.layout, route.pattern)
  const nested = nestedFor(compiled, discovered, route.pattern)
  /**
   * The document, as the layers it is made of: the application's own, then every nested layout
   * from the shallowest directory inwards. `inner` is the last layer, where the page goes.
   */
  const layers = [layout, ...nested]
  const inner = layers[layers.length - 1] as CompiledFragment
  checkChain(layers, route.pattern)
  const holes = chainHoles(layers)
  const body = module_.slots?.body
  const page = compiled.fragments[`route:${route.pattern}`]

  if (!holes.length) {
    throw new GenerateError(
      'E_NO_SLOTS',
      `${documentOf(layers)} declares no <slot> holes, so there is nowhere on it for a page to go`,
    )
  }
  if (!page && !Object.keys(module_.slots ?? {}).length) {
    throw new GenerateError(
      'E_NO_PAGE',
      `${route.pattern} renders nothing. Write the .tsx beside its declaration, or declare what fills each of ${documentOf(layers)}'s slots`,
    )
  }
  // `body` is a convention rather than a requirement: a layout whose regions are four dashboard
  // panels has no single body. What *is* required is that a route's page file has somewhere to go.
  if (route.file && !holes.includes('body')) {
    throw new GenerateError(
      'E_NO_BODY_SLOT',
      `${route.file.split('/').pop()} is a page, but ${inner.file} has no <slot name="body"> to put it in. ` +
        `Either give the layout one, or drop the .tsx and let the declaration name what renders each slot`,
    )
  }

  // Every layout hole is filled, in document order. `body` is the route's own file; anything
  // else is the route's declaration, then a global `app/slots/<name>.tsx`, then empty markup —
  // because an unfilled hole is a build error in the plan layer and silence is worse than a box.
  const declarations: Record<string, { declaration: SlotDeclaration; fragment?: CompiledFragment }> = {}
  for (const name of holes) {
    // A region that renders somewhere else has no local fragment — the contract stands in for it.
    const asked = module_.slots?.[name]
    if (asked?.region?.remote) {
      if (asked.executor) {
        throw new GenerateError(
          'E_REGION_EXECUTOR',
          `${route.pattern} slot '${name}' is a region and names executor '${asked.executor}'. A ` +
            `region's executor is the registry's answer, so declaring one here is two answers to one question`,
        )
      }
      declarations[name] = { declaration: asked }
      continue
    }
    if (name === 'body' && (page || body)) {
      // A declared body wins, and is the only way a route with no `.tsx` renders anything: a page
      // whose content is markup rather than a template should not need an empty template file.
      const fragment = page ?? fragmentFor(compiled, markup, body as SlotDeclaration, route.pattern)
      declarations.body = {
        fragment,
        declaration: {
          ...body,
          ...(module_.load ? { load: module_.load } : {}),
          ...(module_.cache ? { cache: module_.cache } : {}),
          stream: module_.stream ?? false,
          ...(module_.incremental ? { incremental: true } : {}),
          ...(module_.executor ? { executor: module_.executor } : {}),
          ...(module_.budget ? { budget: module_.budget } : {}),
          ...(module_.budgetFor ? { budgetFor: module_.budgetFor } : {}),
          ...(module_.placeholder ? { placeholder: module_.placeholder } : {}),
          ...(module_.refresh !== undefined ? { refresh: module_.refresh } : {}),
          ...(module_.form ? { form: module_.form } : {}),
          ...(module_.live ? { live: true } : {}),
        },
      }
      continue
    }
    const own = module_.slots?.[name]
    if (own) {
      declarations[name] = {
        declaration: own,
        fragment: fragmentFor(compiled, markup, own, route.pattern, name),
      }
      continue
    }
    const global_ = compiled.fragments[`slot:${name}`]
    declarations[name] = global_
      ? { declaration: { stream: false }, fragment: global_ }
      : { declaration: { html: '', stream: false }, fragment: markup }
  }

  const entries = [
    shellSpec(
      layout.entry.id,
      nested.map((link) => ({ at: NESTS_AT, fragment: link.entry.id })),
    ),
    ...(module_.guard
      ? [
          guardSpec('route.guard', {
            ...(module_.redirect ? { redirect: module_.redirect } : {}),
            ...(module_.status ? { status: module_.status } : {}),
          }),
        ]
      : []),
    ...holes.map((name) => {
      const { declaration, fragment } = declarations[name] as (typeof declarations)[string]
      const decided = options.profile?.routes
        .find((r) => r.route === route.pattern)
        ?.slots.find((s) => s.slot === name)
      const builder = declaration.region ? regionOf(name, declaration.region) : slotSpec(name)
      if (fragment) builder.fragment(fragment.entry.id)
      applyPlacement(builder, declaration, decided)
      return builder
    }),
  ]

  const plan = buildPlan(route.pattern, entries, {
    maxConcurrency: module_.maxConcurrency ?? options.maxConcurrency,
    ...(module_.document ? { cache: module_.document } : {}),
    ...(module_.exposes?.length ? { exposes: module_.exposes } : {}),
  })

  // Values captured on the way through, so the adopt payload is derived from the render that
  // actually happened rather than from a second call that could disagree with it.
  const captured = new WeakMap<object, Map<string, Values>>()
  const expose = module_.expose ?? []

  const slots: Record<string, SlotBinding> = {}
  const live: Record<string, LiveSlot> = {}
  const regions: Record<string, LiveSlot> = {}
  /** The bytes behind a region's declared degradation, resolved once here rather than per failure. */
  const degraded: Record<string, { fallback?: Uint8Array; placeholder?: Uint8Array }> = {}
  for (const name of holes) {
    const { declaration, fragment } = declarations[name] as (typeof declarations)[string]
    const values = valuesOf(declaration, options.ports)
    if (declaration.region) {
      const named = declaration.region.fallback
      const found = named ? compiled.fragments[`fragment:${named}`] : undefined
      if (named && !found) {
        throw new GenerateError(
          'E_NO_SUCH_FRAGMENT',
          `${route.pattern} region '${name}' declares fallback '${named}', and app/fragments/${named}.tsx does not exist`,
        )
      }
      degraded[name] = {
        ...(found ? { fallback: render(found.entry, {} as Values, found.resolve) } : {}),
        ...(declaration.placeholder ? { placeholder: utf8.encode(declaration.placeholder) } : {}),
      }
    }
    // A remote region has no local binding by construction, and the plan layer refuses one that
    // does: two things claiming to render a slot is worse than one of them being somewhere else.
    if (fragment) {
      slots[name] = {
        fragment: { entry: fragment.entry, resolve: fragment.resolve },
        values: async (ctx, params) => {
          const resolved = await values(ctx, params)
          const per = captured.get(ctx as unknown as object) ?? new Map<string, Values>()
          per.set(name, resolved)
          captured.set(ctx as unknown as object, per)
          return resolved
        },
        ...(declaration.placeholder
          ? { placeholder: utf8.encode(declaration.placeholder) }
          : { placeholder: utf8.encode('<p class="weft-skeleton"></p>') }),
      }
      const region: LiveSlot = {
        fragment,
        load: values,
        key: `weft:${route.pattern}:${name}`,
        tags: declaration.cache?.tags ?? [],
      }
      regions[name] = region
      if (declaration.live) live[name] = region
    }
  }

  // Cascade order: the layout's, then every fragment this page renders — including the ones it
  // composes rather than the ones a slot named — then the page's own.
  const rendered = new Set<CompiledFragment>(layers)
  for (const name of holes) {
    const fragment = (declarations[name] as (typeof declarations)[string]).fragment
    // A remote region's stylesheet is its own, and it travels with its frames rather than in this
    // page's bundle. A composite that inlined it would be shipping bytes it cannot version.
    if (!fragment) continue
    rendered.add(fragment)
    for (const child of composedIn(compiled, fragment)) rendered.add(child)
  }
  const css = [...new Set([...rendered].flatMap((fragment) => options.styleOf(fragment.file)))]
  if (route.css && !css.includes(route.css)) css.push(route.css)
  if (route.scopedCss && !css.includes(route.scopedCss)) css.push(route.scopedCss)

  const head = module_.head
  const extra = module_.layoutValues
  // Which nav entry is the page you are on, matched with the router rather than by string
  // equality: a nav href is a URL and a route is a pattern, and they are never equal.
  const matcher = createRouter([{ pattern: route.pattern, value: true }])
  const isCurrent = (href: string): boolean => {
    try {
      return Boolean(matcher.match(new URL(href, 'http://weft.local')))
    } catch {
      return false
    }
  }
  const bindings: RouteBindings = {
    shell: { entry: layout.entry, resolve: layout.resolve },
    ...(nested.length
      ? { nested: nested.map((link) => ({ at: NESTS_AT, entry: link.entry, resolve: link.resolve })) }
      : {}),
    shellValues: (params) => {
      const resolved = typeof head === 'function' ? head(params) : (head ?? {})
      return {
        ...(typeof extra === 'function' ? extra(params) : (extra ?? {})),
        title: resolved.title ?? labelOf(route.pattern),
        description: resolved.description ?? '',
        css: options.styleHref(route.pattern),
        runtime: options.runtime(),
        preload: options.preload(),
        canonical: options.canonical(route.pattern, params),
        prelude: SCROLL_PRELUDE,
        brand: options.brand,
        nav: nav.map((item) => ({
          href: item.href,
          label: item.label,
          current: isCurrent(item.href) ? 'yes' : 'no',
        })),
      } as unknown as Values
    },
    slots,
    ...(module_.guard ? { guards: { 'route.guard': module_.guard } } : {}),
  }

  // A layout hole the framework cannot fill is named here rather than rendered empty.
  const supplied = new Set<string>([
    ...STANDARD,
    ...Object.keys(typeof extra === 'function' ? extra({}) : (extra ?? {})),
  ])
  // Every layer, because a nested layout reads the same value set as the one it is inside: the
  // chain is one document with one head, and a hole in the third layer is as unfilled as one in
  // the first.
  for (const layer of layers) {
    // A derived hole is not unfilled — it is computed, and what it is computed *from* is checked
    // instead: a conditional or template literal lowers to a hole bound to a derived id, and every
    // `ref` inside that expression has to be supplied, or a typo would render nothing silently.
    const derived = new Map((layer.entry.derived ?? []).map((entry) => [entry.id, entry.expr]))
    for (const hole of layer.entry.holes) {
      if (hole.kind === 'slot' || hole.kind === 'component') continue
      const expr = derived.get(hole.binding)
      if (expr) {
        const missing = refsIn(expr).find((id) => !supplied.has(id) && !derived.has(id))
        if (!missing) continue
        throw new GenerateError(
          'E_LAYOUT_HOLE_UNFILLED',
          `${layer.file} computes a value from '${missing}', which neither the framework nor ${
            route.data ?? route.pattern
          } supplies. It may read ${[...supplied].join(', ')}, declare <slot> holes for regions, and ` +
            `add anything else through defineRoute({ layoutValues })`,
        )
      }
      if (supplied.has(hole.binding)) continue
      throw new GenerateError(
        'E_LAYOUT_HOLE_UNFILLED',
        `${layer.file} has a hole '${hole.binding}' that neither the framework nor ${
          route.data ?? route.pattern
        } supplies. It may read ${[...supplied].join(', ')}, declare <slot> holes for regions, and ` +
          `add anything else through defineRoute({ layoutValues })`,
      )
    }
  }

  const composes = plan.slots.some((slot) => slot.region)
  const resolver = lowerPlan(
    plan,
    {
      facts,
      executors: Object.keys(options.config.executors),
      // So `E_CONSISTENCY_MISMATCH` has something to check the plan against.
      store: {
        name: options.store.name,
        consistency: options.store.consistency,
        scope: options.store.scope,
      },
      instances: options.config.instances,
    },
    {
      ...bindings,
      // Only when the route composes one, or every route would look like a composite in `weft why`.
      ...(composes ? { regions: { ports: options.ports, degraded } } : {}),
    },
  )
  const order = module_.order
  // A conditional page has to be a complete one: an ETag over a streaming route asks for a digest
  // of something that does not exist yet when the header must be written. See `E_ETAG_STREAMS`.
  if (module_.etag) {
    const streaming = plan.slots.filter((slot) => slot.delivery === 'stream').map((slot) => slot.name)
    const asked = typeof order === 'string' ? order : undefined
    if (streaming.length || asked === 'out-of-order') {
      throw new Error(
        `E_ETAG_STREAMS: ${route.pattern} declares etag and ${
          streaming.length ? `streams ${streaming.join(', ')}` : 'declares out-of-order delivery'
        }. An entity tag is a digest of the whole entity and the envelope is sealed before the first byte, so the two cannot both be true`,
      )
    }
  }
  /** Slots whose budget is a function of the request, and the declared one they override. Collected
   * here because the declaration is build-time knowledge. */
  const perRequest = holes
    .map((name) => ({
      name,
      for: (declarations[name] as (typeof declarations)[string]).declaration.budgetFor,
    }))
    .filter((entry): entry is { name: string; for: NonNullable<typeof entry.for> } => Boolean(entry.for))

  /**
   * The document's identity and reads, over the whole chain. Joined rather than hashed, because
   * they are only ever compared: two routes share a document when built from the same files.
   */
  const documentId = layers.map((layer) => layer.entry.id).join('>')
  const documentVersion = layers.map((layer) => layer.entry.version).join('+')
  /** The document reads what its layers read, and what the route's declaration reads. See `spec/kernel/cache.md`. */
  const documentEffects = unionEffects([
    ...layers.map((layer) => layer.entry.effects),
    { reads: [...declared], writes: [], envelope: [], residency: 'either' },
  ])

  const value: RouteResolver = async (params, url) => {
    const resolved = await resolver(params)
    const query = url?.searchParams ?? new URLSearchParams()
    const overrides = new Map<string, { cpuBudgetMs?: number; onExceed?: ExceedPolicy }>()
    for (const entry of perRequest) {
      const asked = entry.for({ params, query })
      overrides.set(entry.name, {
        ...(asked.cpu !== undefined ? { cpuBudgetMs: every(asked.cpu) } : {}),
        ...(asked.onExceed ? { onExceed: asked.onExceed } : {}),
      })
    }
    return {
      ...resolved,
      // The document is a route, not a layout. See `spec/kernel/cache.md`.
      shell: {
        id: `${documentId}@${route.pattern}`,
        version: documentVersion,
        effects: documentEffects,
      },
      ...(order ? { order: typeof order === 'function' ? order(params) : order } : {}),
      // Assigned rather than spread into a third object nobody else can see.
      slots: resolved.slots.map((slot) =>
        Object.assign(
          wrapSlot(
            slot,
            slot.name,
            route.pattern,
            params,
            declared,
            (declarations[slot.name] as (typeof declarations)[string]).fragment,
            captured,
            expose,
            Boolean(live[slot.name]),
            options.store,
            refreshOf(plan, slot.name),
            options.recorder,
          ),
          overrides.get(slot.name),
        ),
      ),
    }
  }

  const exposes = plan.exposes
  const exposed = async (params: Record<string, string>): Promise<Record<string, string>> => {
    if (!exposes.length) return {}
    const values = (await bindings.shellValues?.(params)) ?? ({} as Values)
    const record = values as unknown as Record<string, unknown>
    // Stringified: these cross a serialisation to another deployment, and a value that differs by
    // type between the two topologies is a bug that only shows up in one of them.
    return Object.fromEntries(exposes.map((name) => [name, String(record[name] ?? '')]))
  }

  const remote: Record<string, RegionSpec> = {}
  for (const spec of plan.slots) {
    if (!spec.region || spec.region.locus !== 'remote') continue
    remote[spec.name] = regionSpecOf(spec, spec.region, degraded[spec.name])
  }

  return {
    pattern: route.pattern,
    plan,
    entry: { pattern: route.pattern, value },
    module: module_,
    etag: Boolean(module_.etag),
    live,
    regions,
    remote,
    exposed,
    shell: { id: documentId, version: documentVersion },
    titleFor: (params) => {
      const resolved = typeof head === 'function' ? head(params) : (head ?? {})
      return resolved.title ?? labelOf(route.pattern)
    },
    holes,
    css,
    static: staticVerdict({
      pattern: route.pattern,
      module: module_,
      shell: inner,
      layers,
      ...(options.written ? { written: options.written } : {}),
      slots: holes.map((name) => {
        const held = declarations[name] as (typeof declarations)[string]
        const entry: {
          name: string
          fragment?: CompiledFragment
          declaration: SlotDeclaration
          streams: boolean
        } = {
          name,
          declaration: held.declaration,
          streams: plan.slots.find((slot) => slot.name === name)?.delivery === 'stream',
        }
        // Assigned rather than spread, because `exactOptionalPropertyTypes` wants the key absent
        // and not present-and-undefined, and that is what an `if` says.
        if (held.fragment) entry.fragment = held.fragment
        return entry
      }),
    }),
  }
}

/** A slot's declared refresh interval, as the client needs it. `when` is the plan's own condition
 * vocabulary, carried across as strings rather than re-modelled. */
function refreshOf(plan: Plan, slot: string): { everyMs: number; when?: readonly string[] } | undefined {
  const spec = plan.slots.find((candidate) => candidate.name === slot)?.refresh
  if (!spec) return undefined
  return { everyMs: spec.everyMs, ...(spec.when?.all.length ? { when: spec.when.all } : {}) }
}
