import { pathToFileURL } from 'node:url'
import { baseRenderId, clientOwned, clientView, readsOf, type Values } from '@weft/ir'
import {
  recordBase,
  type KernelSlot,
  type RenderContext,
  type RouteEntry,
  type RouteResolver,
  type StorePort,
} from '@weft/kernel'
import {
  every,
  factsFrom,
  guard as guardSpec,
  lowerPlan,
  plan as buildPlan,
  shell as shellSpec,
  slot as slotSpec,
  type Plan,
  type RouteBindings,
  type SlotBinding,
  type SlotFacts,
} from '@weft/plan'
import { composedIn, slotHoles, type CompiledApp, type CompiledFragment } from './compile.ts'
import type { Discovered, DiscoveredRoute } from './convention.ts'
import type { CacheDeclaration, RouteModule, SlotDeclaration } from './route.ts'
import type { ExceedPolicy } from './types.ts'
import type { ResolvedConfig } from './config.ts'

const utf8 = new TextEncoder()

/**
 * The generated plan, which is the whole point of the convention.
 *
 * A route file and its declaration become a `Plan` and a `RouteBindings` — the pair that was
 * always the framework's real input and that, until now, every application had to write by
 * hand. Two hundred lines of wiring per application became this file once.
 *
 * Nothing here invents a fact. Cache classes, read sets and escape decisions come from the
 * compiler; placement comes from the route's own declaration; and the plan is validated
 * against the former before it is lowered, so a declaration that contradicts the code fails
 * the build with the read that caused it named.
 */
export interface GeneratedRoute {
  pattern: string
  plan: Plan
  entry: RouteEntry<RouteResolver>
  module: RouteModule
  /** Slots this route can refresh over the channel, by slot name. */
  live: Record<string, LiveSlot>
  /**
   * Stylesheets this route links, in cascade order: the page's own, and the one belonging to
   * every fragment it actually renders. A page links the CSS of the components on it and no
   * others, which is the same argument the design makes about templates one level up.
   */
  css: string[]
}

export interface LiveSlot {
  fragment: CompiledFragment
  load: (ctx: RenderContext, params: Record<string, string>) => Promise<Values>
  key: string
  tags: string[]
}

export interface Generated {
  routes: GeneratedRoute[]
  facts: Record<string, SlotFacts>
  /** Which layout hole each route fills with what, for `weft build`'s report. */
  layoutSlots: string[]
}

export class GenerateError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(`${code} — ${message}`)
    this.name = 'GenerateError'
    this.code = code
  }
}

/** The layout values the framework always supplies. A layout may use any subset of these. */
const STANDARD = ['title', 'description', 'css', 'runtime', 'brand', 'nav'] as const

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
  const last = pattern.split('/').filter(Boolean).at(-1) as string
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

function applyPlacement(
  builder: ReturnType<typeof slotSpec>,
  declaration: SlotDeclaration,
): ReturnType<typeof slotSpec> {
  const stream = declaration.stream
  if (stream === false) builder.buffered()
  else if (typeof stream === 'object') builder.stream(stream.prio === undefined ? {} : { prio: stream.prio })
  else if (stream === true) builder.stream()
  else builder.buffered()

  const cache = cacheOf(declaration.cache)
  if (cache) builder.cache(...cache)
  if (declaration.incremental) builder.incremental()
  if (declaration.executor) builder.executor(declaration.executor)
  if (declaration.budget) builder.budget(declaration.budget)
  if (declaration.refresh !== undefined) builder.refresh(every(declaration.refresh))
  if (declaration.form) builder.form(declaration.form)
  if (declaration.needs?.length) builder.needs(...declaration.needs)
  return builder
}

/**
 * The document a route is wrapped in.
 *
 * Named layouts exist because a page with a different shape needs different slot holes, and the
 * plan is generated per route — so nothing has to agree across routes about what the holes are.
 * That is the property a single global layout was quietly costing.
 */
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
 * Which fragment renders a slot, given what its declaration named.
 *
 * `html` means markup rather than content, and goes through the framework's one deliberately
 * unescaped fragment. A name means `app/fragments/<name>.tsx`. Neither means the global
 * `app/slots/<name>.tsx`, and none of the three means a build error that names all three ways
 * out — a slot that renders nothing should say so before it is deployed.
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
 * What a slot's values are, whatever the declaration said. A `load` is data, an `html` is
 * markup that goes through the framework's one unescaped fragment, and a slot with neither
 * renders its fragment with no values — which is right for a static header.
 */
function valuesOf(
  declaration: SlotDeclaration,
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
    return async (ctx, params) => (await load(ctx, params)) as Values
  }
  return async () => ({}) as Values
}

/**
 * The adopt payload, derived rather than written.
 *
 * A page's client work is a function of what the compiler put in the template: a signal
 * declaration, a wiring entry, a derived expression. So the framework can produce the whole
 * table — and produce nothing at all for a slot with no wiring, which is the case that should
 * cost nothing and previously cost an application a hand-written script tag either way.
 */
export interface AdoptOptions {
  /** Extra value names beyond the ones a client-owned derived expression is seen to read. */
  expose?: readonly string[]
  /** Refreshable over the channel, which is what tells the client to connect on load. */
  live?: boolean
  /** What the client queries to find the region. Defaults to the slot's own wrapper. */
  selector?: string
}

/**
 * The adopt payload: everything the client needs to bind a rendered region, and nothing else.
 *
 * Exported because a page whose subject *is* adoption has to be able to show you the real one.
 * A demo that hand-rolled this would be showing you a payload the runtime does not read, which
 * is worse than showing nothing — it looks right and does nothing.
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
  // Every template, not only the entry: a quantity box inside a list row has its wiring in the
  // row's template, and a region whose only interactive part is a row is still interactive.
  const nested = fragment.templates.filter((template) => template.version !== entry.version)
  const interactive = fragment.templates.some((t) => t.wiring.length > 0 || t.signals.length > 0)
  // A static slot ships nothing. That is the case a hand-written script tag could never get
  // right, because it had to be written before anyone knew whether the slot needed one.
  if (!interactive && !live) return null

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
    /**
     * The row and component templates this region needs.
     *
     * Adoption walks a list hole by looking up `hole.nested` in the templates the client holds,
     * so a region whose rows carry wiring is unadoptable without them. Shipping only the entry
     * meant a quantity box inside a row was bound to nothing at all — the markup was there, the
     * wiring was in the IR, and nothing connected the two.
     */
    templates: nested.map(clientView),
    base: baseRenderId(entry, values),
    signals: entry.signals.map((declaration) => ({ id: declaration.id, init: declaration.init })),
    values: exposed,
    intents,
    live,
  }
  return `<script type="application/json" data-weft="adopt">${JSON.stringify(payload).replace(
    /</g,
    '\\u003c',
  )}</script>`
}

/**
 * Which values the browser needs, derived rather than declared.
 *
 * A client-owned derived value is one whose expression reads a signal, and the client recomputes
 * it — so it needs every *other* binding that expression reads. `qty() * unitPrice` is recomputed
 * in the browser, so the browser needs `unitPrice`, and nothing else out of the value set.
 *
 * This was a declaration on the route until it was obvious it should not be: the answer is in the
 * IR, and a page that had to list these by hand is a page whose list goes stale the moment
 * somebody edits the template. What is left of `expose` is an override, for a value the browser
 * needs for a reason the template cannot show.
 */
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
 * Every slot's bytes get a wrapper element, and that is not decoration.
 *
 * Adoption addresses nodes by index from a root, so the root has to be an element whose
 * children are exactly the template's top-level nodes — which a bare `<slot>` is not once
 * anything else is inside it. The wrapper is also what a channel delta and an HTML fallback
 * target by name, so one element serves three mechanisms.
 */
function wrapSlot(
  slot: KernelSlot,
  name: string,
  pattern: string,
  fragment: CompiledFragment,
  captured: WeakMap<object, Map<string, Values>>,
  expose: readonly string[],
  live: boolean,
  store: StorePort,
): KernelSlot {
  const open = utf8.encode(`<div data-weft-slot="${name}">`)
  return {
    ...slot,
    /**
     * The cached thing is a slot on a route, not a fragment.
     *
     * A cache key is `id@version` plus the reads the compiler saw, and it is resolved *before* the
     * render — so it cannot contain a hash of values it has not computed yet. That is sound while
     * a fragment's values are a function of its own reads, which is true when an application binds
     * one fragment to one slot by hand.
     *
     * A generated plan breaks it. Four pages bind the framework's `markup` fragment to four slots
     * with four different loaders, and `markup` reads nothing — so all four resolve to one key and
     * the first one to render answers for the rest. Scoping the id to the route and slot is what
     * makes them four cached things. Two tabs on the same route and slot still share one, which is
     * the sharing that was ever worth having.
     */
    id: `${slot.id}@${pattern}:${name}`,
    render: async (ctx) => {
      const bytes = await slot.render(ctx)
      const values = captured.get(ctx as unknown as object)?.get(name)
      /**
       * A live slot records the render the client is about to be shown.
       *
       * A delta is computed against the base the client says it is holding, and the server can
       * only do that if it can recover that base. Without this the *first* refresh on every page
       * fell back to sending the region's HTML — the delta path only started working on the
       * second interaction, which is the one nobody measures and everybody notices.
       */
      if (live && values) await recordBase(store, fragment.entry, values)
      const script = values ? adoptScript(name, fragment, values, { expose, live }) : null
      const tail = utf8.encode(script ? `</div>${script}` : '</div>')
      const out = new Uint8Array(open.length + bytes.length + tail.length)
      out.set(open, 0)
      out.set(bytes, open.length)
      out.set(tail, open.length + bytes.length)
      return out
    },
  }
}

export interface GenerateOptions {
  discovered: Discovered
  compiled: CompiledApp
  config: ResolvedConfig
  /**
   * The one stylesheet a page links, resolved when the page renders rather than when it is
   * generated. The URL carries a digest of the bundle's contents, and the bundle is not
   * assembled until the generator has said which fragments the page renders — so the href does
   * not exist yet at generation time, and pretending otherwise would mean an unrevved URL.
   */
  styleHref(pattern: string): string
  /** A fragment file's colocated stylesheet, if it brought one. */
  styleOf(file: string): string | undefined
  /** Where a live slot's base render is recorded, so its first refresh can be a delta. */
  store: StorePort
  /** The client entry the layout loads. Also a digest-bearing URL, so also resolved late. */
  runtime(): string
  brand: string
}

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

async function generateOne(route: DiscoveredRoute, options: OneOptions): Promise<GeneratedRoute> {
  const { compiled, markup, facts, nav } = options
  const module_ = await loadModule(route.data)
  const layout = layoutFor(compiled, module_.layout, route.pattern)
  const holes = slotHoles(layout)
  const body = module_.slots?.body
  const page = compiled.fragments[`route:${route.pattern}`]

  if (!holes.length) {
    throw new GenerateError(
      'E_NO_SLOTS',
      `${layout.file} declares no <slot> holes, so there is nowhere on it for a page to go`,
    )
  }
  if (!page && !Object.keys(module_.slots ?? {}).length) {
    throw new GenerateError(
      'E_NO_PAGE',
      `${route.pattern} renders nothing. Write the .tsx beside its declaration, or declare what fills each of ${layout.file}'s slots`,
    )
  }
  // `body` is a convention rather than a requirement: a layout whose regions are four dashboard
  // panels has no single body. What *is* required is that a route's page file has somewhere to go.
  if (route.file && !holes.includes('body')) {
    throw new GenerateError(
      'E_NO_BODY_SLOT',
      `${route.file.split('/').pop()} is a page, but ${layout.file} has no <slot name="body"> to put it in. ` +
        `Either give the layout one, or drop the .tsx and let the declaration name what renders each slot`,
    )
  }

  // Every layout hole is filled, in document order. `body` is the route's own file; anything
  // else is the route's declaration, then a global `app/slots/<name>.tsx`, then empty markup —
  // because an unfilled hole is a build error in the plan layer and silence is worse than a box.
  const declarations: Record<string, { declaration: SlotDeclaration; fragment: CompiledFragment }> = {}
  for (const name of holes) {
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
    shellSpec(layout.entry.id),
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
      return applyPlacement(slotSpec(name).fragment(fragment.entry.id), declaration)
    }),
  ]

  const plan = buildPlan(route.pattern, entries, {
    maxConcurrency: module_.maxConcurrency ?? options.maxConcurrency,
    ...(module_.document ? { cache: module_.document } : {}),
  })

  // Values captured on the way through, so the adopt payload is derived from the render that
  // actually happened rather than from a second call that could disagree with it.
  const captured = new WeakMap<object, Map<string, Values>>()
  const expose = module_.expose ?? []

  const slots: Record<string, SlotBinding> = {}
  const live: Record<string, LiveSlot> = {}
  for (const name of holes) {
    const { declaration, fragment } = declarations[name] as (typeof declarations)[string]
    const values = valuesOf(declaration)
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
    if (declaration.live) {
      live[name] = {
        fragment,
        load: values,
        key: `weft:${route.pattern}:${name}`,
        tags: declaration.cache?.tags ?? [],
      }
    }
  }

  // Cascade order: the layout's, then every fragment this page renders — including the ones it
  // composes rather than the ones a slot named — then the page's own.
  const rendered = new Set<CompiledFragment>([layout])
  for (const name of holes) {
    const fragment = (declarations[name] as (typeof declarations)[string]).fragment
    rendered.add(fragment)
    for (const child of composedIn(compiled, fragment)) rendered.add(child)
  }
  const css = [
    ...new Set(
      [...rendered]
        .map((fragment) => options.styleOf(fragment.file))
        .filter((value): value is string => Boolean(value)),
    ),
  ]
  if (route.css && !css.includes(route.css)) css.push(route.css)

  const head = module_.head
  const extra = module_.layoutValues
  const bindings: RouteBindings = {
    shell: { entry: layout.entry, resolve: layout.resolve },
    shellValues: (params) => {
      const resolved = typeof head === 'function' ? head(params) : (head ?? {})
      return {
        ...(typeof extra === 'function' ? extra(params) : (extra ?? {})),
        title: resolved.title ?? labelOf(route.pattern),
        description: resolved.description ?? '',
        css: options.styleHref(route.pattern),
        runtime: options.runtime(),
        brand: options.brand,
        nav: nav.map((item) => ({
          href: item.href,
          label: item.label,
          current: item.href === route.pattern ? 'yes' : 'no',
        })),
      } as unknown as Values
    },
    slots,
    ...(module_.guard ? { guards: { 'route.guard': module_.guard } } : {}),
  }

  // A layout hole the framework cannot fill is named here rather than rendered empty. The
  // whole argument for a convention is that what is missing is missing loudly.
  const supplied = new Set<string>([
    ...STANDARD,
    ...Object.keys(typeof extra === 'function' ? extra({}) : (extra ?? {})),
  ])
  for (const hole of layout.entry.holes) {
    if (hole.kind === 'slot' || hole.kind === 'component') continue
    if (supplied.has(hole.binding)) continue
    throw new GenerateError(
      'E_LAYOUT_HOLE_UNFILLED',
      `${layout.file} has a hole '${hole.binding}' that neither the framework nor ${
        route.data ?? route.pattern
      } supplies. It may read ${[...supplied].join(', ')}, declare <slot> holes for regions, and ` +
        `add anything else through defineRoute({ layoutValues })`,
    )
  }

  const resolver = lowerPlan(plan, { facts, executors: Object.keys(options.config.executors) }, bindings)
  const order = module_.order
  /**
   * Slots whose budget is a function of the request, and the declared one they override.
   *
   * Collected here rather than looked up per request: the declaration is build-time knowledge,
   * and a resolver that had to re-read it on every request would be doing the plan's work again.
   */
  const perRequest = holes
    .map((name) => ({
      name,
      for: (declarations[name] as (typeof declarations)[string]).declaration.budgetFor,
    }))
    .filter((entry): entry is { name: string; for: NonNullable<typeof entry.for> } => Boolean(entry.for))

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
      /**
       * The document is a route, not a layout.
       *
       * Every page sharing `layout.tsx` shares its id and version, so a document policy would
       * make all of them one cache entry — and the first page rendered would answer for the rest.
       * The same reasoning as the slot ids below, one level up.
       */
      shell: {
        id: `${layout.entry.id}@${route.pattern}`,
        version: layout.entry.version,
        effects: layout.entry.effects,
      },
      ...(order ? { order: typeof order === 'function' ? order(params) : order } : {}),
      slots: resolved.slots.map((slot) => ({
        ...wrapSlot(
          slot,
          slot.name,
          route.pattern,
          (declarations[slot.name] as (typeof declarations)[string]).fragment,
          captured,
          expose,
          Boolean(live[slot.name]),
          options.store,
        ),
        ...overrides.get(slot.name),
      })),
    }
  }

  return {
    pattern: route.pattern,
    plan,
    entry: { pattern: route.pattern, value },
    module: module_,
    live,
    css,
  }
}
