import { pathToFileURL } from 'node:url'
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
   * Every region of this route, live or not, by slot name.
   *
   * `live` is the subset a slot declared refreshable, which is the right gate for a *refresh*: a
   * region nobody said could change should not be re-rendered under a reader. Staging a route is
   * the other question — the reader is about to see the whole page, so every region of it has to
   * be produced — and the gate for that is whether the route was asked for at all.
   */
  regions: Record<string, LiveSlot>
  /**
   * Regions of this route that render on another deployment, by slot name, as the composer needs them.
   *
   * Carried on the route because a region is composed on three paths and only one of them is the
   * document request: a refresh over the channel and a route being staged both have to reach the same
   * region with the same budget, the same contract and the same declared degradation. The derivation
   * is the plan layer's — `regionSpecOf` — so nothing here can disagree with what the document did.
   */
  remote: Record<string, RegionSpec>
  /**
   * The shell values this route offers its regions, resolved for a set of params.
   *
   * The one channel between a shell and the regions inside it, read from the same `shellValues` the
   * document rendered with rather than from a second source — so what a region is handed over the
   * channel is what the page it is part of actually shows. Empty for a route that exposes nothing,
   * which is every route until one says otherwise.
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
   *
   * Structural only: it is what the compiler and the plan already know, which is everything
   * except what the route's own loader does. `prerender` settles that half by measurement.
   */
  static: StaticVerdict
  /**
   * Whether this route answers conditional requests, which means the front door holds its response
   * back until it is complete and digests it. Declared by the route, refused where it contradicts
   * the plan's own delivery — see `E_ETAG_STREAMS`.
   */
  etag: boolean
  /**
   * Stylesheets this route links, in cascade order: the page's own, and the one belonging to
   * every fragment it actually renders. A page links the CSS of the components on it and no
   * others, which is the same argument the design makes about templates one level up.
   */
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
const STANDARD = ['title', 'description', 'css', 'runtime', 'brand', 'nav', 'prelude'] as const

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

/**
 * Placement, and the one part of it a measurement may overrule.
 *
 * A profile decides delivery and nothing else. It cannot move a fragment, change a cache class or
 * touch a key: those are the compiler's and the convention's, and a recording of last Tuesday has
 * no standing over any of them. What it does have standing over is whether a region is worth its
 * own flush, which is a question about milliseconds — and the declaration loses that one, because
 * the declaration was a guess and this is a measurement.
 */
/**
 * The placement a slot and a region share, which is all of it except where the render happens.
 *
 * Structural rather than over `SlotBuilder`, because a region builder deliberately has no
 * `executor` method: a region's executor is the reserved name meaning *the registry decides*, and a
 * builder that could also be handed a tier would be two answers to one question. Everything else —
 * delivery, cache, budget, refresh, form, needs — is identical, which is the point the plan layer
 * makes by building a region out of a slot in the first place.
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
 * A region, as the plan layer's builder, from what the route declared.
 *
 * The one thing this does *not* transcribe is where the region runs. `remote` says a boundary is
 * crossed and the contract says what the shell expects to find on the far side; which deployment
 * that is comes from `weft.config.ts`, so rolling a region is a write there rather than a rebuild
 * here. That omission is the whole reason the registry is a port.
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
 * The nested layouts a route is wrapped in, outermost first.
 *
 * The chain comes from the file tree — `app/routes/dashboard/layout.tsx` wraps `/dashboard` and
 * everything under it — so nothing declares it and nothing can declare it differently. What each
 * link fills is `body`, which is the same convention the page itself uses one level in: a layout
 * hole named `body` is where the thing this document wraps goes, whether that thing is a page or
 * another layout.
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
 * Every boundary a chain leaves, in document order.
 *
 * Not a concatenation: a nested layout's holes appear where the layout does, so a chain whose outer
 * document is header/body/footer and whose inner one is main/aside leaves header, main, aside,
 * footer — and the stream sends them in that order. Concatenating would put the footer's bytes
 * before the inner layout's, which is the one thing document order is for.
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
 * A chain has to be a chain: every layer but the innermost needs a hole for the next one.
 *
 * Checked here rather than left to the plan layer because the plan layer sees fragment ids and
 * this sees files — and "app/routes/dashboard/layout.tsx has nowhere to go" is the sentence
 * somebody can act on. A duplicate hole name is refused for the same reason: the plan keys slots
 * by name and the client addresses regions by name, so two layers leaving `aside` would be one
 * region with two places to be.
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
/**
 * A slot's values, and the context its loader is given.
 *
 * The kernel's context is what tracks reads; `withServices` adds what the deployment bound — a
 * settings table and a data port — without touching it. Wrapping here rather than in the kernel
 * is deliberate: a loader is a front-door concept, so what a loader can reach is the front door's
 * decision and costs the document request path nothing.
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
  /**
   * `refresh(everyMs, { when })` from the plan, carried to the client that has to act on it.
   *
   * It was recorded and read by one thing — a build-time warning about a remote region with cache
   * tags and no interval, which named the interval as the design's stated fallback for push
   * invalidation across a tier boundary. That made it the fallback nothing implemented. The client
   * asks on an interval instead, under the conditions the plan declared: `visible` because a tab
   * nobody is looking at should not poll, `focused` and `idle` for the same reason at finer grain.
   */
  refresh?: { everyMs: number; when?: readonly string[] }
}

/**
 * The adopt payload: everything the client needs to bind a rendered region, and nothing else.
 *
 * Exported because a page whose subject *is* adoption has to be able to show you the real one.
 * A demo that hand-rolled this would be showing you a payload the runtime does not read, which
 * is worse than showing nothing — it looks right and does nothing.
 */
/**
 * The scroll restore, as bytes in the document rather than code in the module.
 *
 * It used to live in `boot.ts`, whose comment argued that a deferred module runs after parsing and
 * therefore before the next paint. The argument is sound and the premise is wrong: a module body does
 * not run until its whole static import graph resolves, and the client's is nineteen modules. Measured
 * on a dev server, render-blocking CSS finished at 37 ms and the module graph at 48 ms — so the page
 * sat painted at the top for eleven milliseconds and then jumped, which is the blink that comment was
 * written to prevent.
 *
 * Nothing inside the module graph can fix that, so this is a classic inline script and a layout
 * renders it at the end of the body: during parse, with the document's height already known, long
 * before anything is fetched. A layout that does not render it is not broken — the value goes unused
 * and `boot.ts` still restores, late, exactly as before.
 *
 * A key existing is the whole condition, and it is enough because recording is what decides. While
 * the engine owns scroll nothing records, so a reload finds no key here and the engine restores it
 * natively before the first paint; once the framework has taken scroll over, `pagehide` records and
 * this is what puts it back. Gating on the navigation type instead was tried and was wrong twice: it
 * consumed the key before deciding to stand down, which destroyed the position outright, and it
 * stood down on exactly the reload that had nobody else to restore it.
 *
 * Keyed on the pathname alone, matching `handOff`, and that is the point rather than an oversight.
 * Pressing Compile on the playground goes to a different *query* on the same path, which is precisely
 * the navigation whose position is worth keeping — keying on the query too was tried here and meant
 * the key written on the way out never matched the page that arrived, so nothing was ever restored
 * and every submit leaked a key.
 */
const SCROLL_PRELUDE =
  '<script>(function(){try{' +
  'var k="weft:scroll:"+location.pathname,v=sessionStorage.getItem(k);if(!v)return;' +
  'sessionStorage.removeItem(k);var y=+v;if(!(y>0))return;' +
  'var land=function(){window.scrollTo({top:y,behavior:"instant"})};land();' +
  // Recorded so a readout can say *when* the restore happened rather than that it did. The number is
  // the whole argument for this script existing: it has to be under the first paint.
  'window.__weftScrollAt=performance.now();' +
  /**
   * The same re-land `boot.ts` had, kept here because this script is now the one that consumes the
   * key — so without it the safety net was simply gone. A streamed slot, a late font or an image with
   * no dimensions can all change the height after this runs, and then the first attempt fell short.
   * Skipped entirely if the reader has since scrolled themselves, which is the only signal that the
   * position is no longer wanted.
   */
  'if(document.readyState!=="complete")addEventListener("load",function(){' +
  'if(Math.abs(window.scrollY-y)>4&&window.scrollY<4)land()},{once:true})' +
  '}catch(e){}})()</script>'

/**
 * The payload that binds a slot's template to the markup this render produced, or null.
 *
 * Null for a slot nothing on the client could act on, which is the case a hand-written script tag
 * could never get right — it had to be written before anyone knew whether the slot needed one.
 * `selector` exists so a caller that is not a slot can name the element it rendered into.
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
  /**
   * What the client could actually do with a payload for this slot.
   *
   * Wiring alone is not it, and counting it was costing real bytes. `wire()` resolves every
   * non-event entry through `bindDerived(derived, signals)`, so with no signals that lookup misses
   * and every entry hits its `continue` — the region is walked and nothing is bound. A slot whose
   * only wiring is a `list` op over server data is exactly that case, and it is the common one:
   * any fragment that maps a list has wiring, so any page whose body became a fragment shipped a
   * payload describing templates nothing would ever write to. On this site that was 28 kB per
   * error page, over 327 of them.
   *
   * So the question is not whether wiring exists but whether anything can drive it: a signal to
   * change a value, an intent to attach a listener to, a channel to deliver a delta, or another
   * region reading exposed values out of this one.
   */
  const hasSignals = fragment.templates.some((t) => t.signals.length > 0)
  const hasEvents = fragment.templates.some((t) => t.wiring.some((w) => w.op === 'event'))
  // A static slot ships nothing. That is the case a hand-written script tag could never get
  // right, because it had to be written before anyone knew whether the slot needed one.
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
    // Only for a slot that can actually be refreshed. An interval on a region the channel cannot
    // refresh would be a timer that fires forever and asks nobody.
    ...(live && options.refresh ? { refresh: options.refresh } : {}),
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
/**
 * The params a slot's cache identity has to carry, as a stable string.
 *
 * Sorted, because two requests to the same route must not resolve to two keys because the router
 * happened to fill the map in a different order.
 */
function paramsOf(params: Record<string, string>): string {
  const entries = Object.entries(params).sort(([a], [b]) => a.localeCompare(b))
  return entries.length ? `?${entries.map(([k, v]) => `${k}=${v}`).join('&')}` : ''
}

function wrapSlot(
  slot: KernelSlot,
  name: string,
  pattern: string,
  params: Record<string, string>,
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
     *
     * The params are the same argument one level down, and it took a second page to see it.
     * `/app/ordinary/:category` is one route, one slot and one template, and its loader is a `.ts`
     * file the compiler never reads — so `route:category` is not in the effect set, the key cannot
     * contain it, and whichever category rendered first answered for the other one. A route param
     * is part of what a slot on a generated route *is*, so it is part of the identity, and a
     * loader that ignores its params pays a cache entry per param rather than a wrong page.
     */
    id: `${slot.id}@${pattern}:${name}${paramsOf(params)}`,
    render: async (ctx) => {
      /**
       * Where a profile's numbers come from.
       *
       * Here rather than in a telemetry port, because a port sees `slot.render` with a slot name
       * and no route — and `body` is a different slot on every page. This wrapper is the one place
       * that holds both, and it is only reached when the store did not already have the bytes, so
       * a render counted here is a render that happened.
       */
      const at = recorder ? performance.now() : 0
      const bytes = await slot.render(ctx)
      recorder?.render(pattern, name, performance.now() - at, bytes.length)
      const values = captured.get(ctx as unknown as object)?.get(name)
      /**
       * A live slot records the render the client is about to be shown.
       *
       * A delta is computed against the base the client says it is holding, and the server can
       * only do that if it can recover that base. Without this the *first* refresh on every page
       * fell back to sending the region's HTML — the delta path only started working on the
       * second interaction, which is the one nobody measures and everybody notices.
       */
      if (live && fragment && values) await recordBase(store, fragment.entry, values)
      /**
       * A remote region ships no adopt payload from here, and that is the right silence.
       *
       * Adoption binds a template this process compiled to markup this process rendered. A region's
       * markup came from another deployment along with its own templates, in its own frames — so the
       * payload that binds it is the region's to send, and one written here would describe a
       * template this process has never seen.
       */
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
  /**
   * The one stylesheet a page links, resolved when the page renders rather than when it is
   * generated. The URL carries a digest of the bundle's contents, and the bundle is not
   * assembled until the generator has said which fragments the page renders — so the href does
   * not exist yet at generation time, and pretending otherwise would mean an unrevved URL.
   */
  styleHref(pattern: string): string
  /**
   * A fragment file's colocated stylesheets, in cascade order: the global `.css` first, then the
   * `.scoped.css` narrowed to that fragment's own elements. Either may be absent.
   */
  styleOf(file: string): readonly string[]
  /** Where a live slot's base render is recorded, so its first refresh can be a delta. */
  store: StorePort
  /** What this deployment bound. A loader is handed the services half of it. */
  ports: Ports
  /**
   * What a recording of this application decided about delivery, if there is one.
   *
   * Placement stays the convention's: which fragment fills which hole is a fact about the file
   * tree. What a profile decides is the half that is about *time* — whether a region is worth
   * arriving separately — because that is not in the file tree and an author asked to guess it
   * guesses `stream: true` on everything.
   */
  profile?: Decisions
  /** Where a render's cost is recorded, when this process was asked to record one. */
  recorder?: Recorder
  /** The client entry the layout loads. Also a digest-bearing URL, so also resolved late. */
  runtime(): string
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

async function generateOne(route: DiscoveredRoute, options: OneOptions): Promise<GeneratedRoute> {
  const { compiled, markup, facts, nav, discovered } = options
  const module_ = await loadModule(route.data)
  const layout = layoutFor(compiled, module_.layout, route.pattern)
  const nested = nestedFor(compiled, discovered, route.pattern)
  /**
   * The document, as the layers it is made of: the application's own, then every nested layout
   * from the shallowest directory inwards.
   *
   * One list, used everywhere `layout` alone used to be, because every question about a document
   * is a question about the whole chain — which holes it leaves, what it reads, what stylesheets it
   * links, and which two routes are the same document. `inner` is the layer the page goes in, which
   * is the last one; for a route with no nested layout that is the application's own and every
   * expression below reduces to what it was.
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
    /**
     * A region that renders somewhere else has no local fragment, and that is not a gap to fill.
     *
     * Every other branch below resolves a slot to compiled bytes-producer in this process. A remote
     * region's producer is another deployment, so there is nothing here to name — what stands in for
     * it is the contract, which is where its reads and therefore the document's cache class come
     * from. Anything that reaches for a fragment past this point has to cope with its absence, and
     * the type says so rather than a comment.
     */
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
  /**
   * The bytes behind a region's declared degradation, resolved once here rather than per failure.
   *
   * A `fallback` names a fragment and the plan layer refuses a name nothing supplies bytes for, so
   * this is where the name becomes bytes: rendered with no values, because a fallback that needed a
   * loader would need the loader that just failed.
   */
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
  /**
   * Which nav entry is the page you are on, decided by the router rather than by string equality.
   *
   * A nav href is a URL somebody can click and a route is a pattern, so `/app/ordinary/pantry`
   * and `/app/ordinary/:category` are never equal — and every parameterised page in the chrome
   * was therefore permanently not-current. Matching with the same router that resolved the
   * request means one notion of "this URL is that page", not two.
   */
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

  // A layout hole the framework cannot fill is named here rather than rendered empty. The
  // whole argument for a convention is that what is missing is missing loudly.
  const supplied = new Set<string>([
    ...STANDARD,
    ...Object.keys(typeof extra === 'function' ? extra({}) : (extra ?? {})),
  ])
  // Every layer, because a nested layout reads the same value set as the one it is inside: the
  // chain is one document with one head, and a hole in the third layer is as unfilled as one in
  // the first.
  for (const layer of layers) {
    /**
     * A derived hole is not unfilled — it is computed, and what it is computed *from* is checked
     * instead.
     *
     * `{title ? … : …}` and `` class={`note note-${kind}`} `` lower to a hole bound to `d0`, with
     * the expression tree beside it in `entry.derived`. The renderer resolves those from the values
     * it was handed before it writes a byte, so `d0` is never something a route could supply —
     * counting it as unfilled made every conditional and every template literal in a layout an
     * `E_LAYOUT_HOLE_UNFILLED` naming a binding nobody wrote and nobody could.
     *
     * Skipping them outright would be the other mistake: a typo inside the expression would then
     * render nothing, silently, which is exactly what this check exists to prevent. So the tree is
     * walked and every `ref` in it has to be supplied — a hole in a layout is still unfilled when
     * what it reads is missing, whether it reads it directly or through an expression.
     */
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
    { facts, executors: Object.keys(options.config.executors) },
    {
      ...bindings,
      // Only when the route composes one. A plan with no region needs no ports here, and passing
      // them anyway would make every route look like a composite in `weft why`.
      ...(composes ? { regions: { ports: options.ports, degraded } } : {}),
    },
  )
  const order = module_.order
  /**
   * A conditional page has to be a complete one.
   *
   * `orderOf` in the plan layer already derives `out-of-order` from any slot that asked to stream,
   * so this is the same fact seen from the other side: a route that declares an ETag and streams is
   * asking for a digest of something that does not exist yet when the header has to be written.
   * Refused where it is declared, with both halves named.
   */
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

  /**
   * The document's identity and reads, over the whole chain.
   *
   * A nested layout is part of the document, so what it reads is what the document reads — leaving
   * it out would advertise a page as shareable on the strength of its outer layout alone. The id
   * and version are joined rather than hashed because they are only ever compared: two routes share
   * a document when they were built from the same files in the same order.
   */
  const documentId = layers.map((layer) => layer.entry.id).join('>')
  const documentVersion = layers.map((layer) => layer.entry.version).join('+')
  const documentEffects = unionEffects(layers.map((layer) => layer.entry.effects))

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
        id: `${documentId}@${route.pattern}`,
        version: documentVersion,
        effects: documentEffects,
      },
      ...(order ? { order: typeof order === 'function' ? order(params) : order } : {}),
      slots: resolved.slots.map((slot) => ({
        ...wrapSlot(
          slot,
          slot.name,
          route.pattern,
          params,
          (declarations[slot.name] as (typeof declarations)[string]).fragment,
          captured,
          expose,
          Boolean(live[slot.name]),
          options.store,
          refreshOf(plan, slot.name),
          options.recorder,
        ),
        ...overrides.get(slot.name),
      })),
    }
  }

  const exposes = plan.exposes
  const exposed = async (params: Record<string, string>): Promise<Record<string, string>> => {
    if (!exposes.length) return {}
    const values = (await bindings.shellValues?.(params)) ?? ({} as Values)
    const record = values as unknown as Record<string, unknown>
    // Stringified for the reason the server side stringifies them: these cross a serialisation on
    // their way to another deployment, and a value that was a number in one topology and a string in
    // the other is a bug that only shows up in one of them.
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
      slots: holes.map((name) => {
        const held = declarations[name] as (typeof declarations)[string]
        return {
          name,
          ...(held.fragment ? { fragment: held.fragment } : {}),
          declaration: held.declaration,
          streams: plan.slots.find((slot) => slot.name === name)?.delivery === 'stream',
        }
      }),
    }),
  }
}

/**
 * A slot's declared refresh interval, as the client needs it: milliseconds and the conditions.
 *
 * `when` is the plan's own condition vocabulary — `visible`, `focused`, `idle` — carried across as
 * strings rather than re-modelled, because the client is the only layer that can evaluate any of
 * them and a second spelling would be a second thing to keep in agreement.
 */
function refreshOf(plan: Plan, slot: string): { everyMs: number; when?: readonly string[] } | undefined {
  const spec = plan.slots.find((candidate) => candidate.name === slot)?.refresh
  if (!spec) return undefined
  return { everyMs: spec.everyMs, ...(spec.when?.all.length ? { when: spec.when.all } : {}) }
}
