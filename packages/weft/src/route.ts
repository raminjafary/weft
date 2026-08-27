import type { Values } from '@weftjs/ir'
import type { EnvelopeContext, RegionContract, RenderContext } from '@weftjs/kernel'
import type { LoaderContext } from './context.ts'
import type { ExceedPolicy, PolicyClass, WireForm } from './types.ts'

/**
 * What a route declares, and the whole of it.
 *
 * Everything here is either placement — which the plan layer owns — or data, which the
 * application owns. There is deliberately no cache key: keys are derived from what the
 * compiler saw a fragment read, and a declaration that could state one could disagree
 * with the code. `weft build` turns this object into a `Plan` and a `RouteBindings`, which
 * is the pair the framework already had and the user had to write by hand.
 */
export type RouteLoad = (
  ctx: LoaderContext,
  params: Record<string, string>,
) => Values | Promise<Values> | Record<string, unknown> | Promise<Record<string, unknown>>

/** What a slot declares about being held. Checked against what its fragment reads. */
export interface CacheDeclaration {
  class: PolicyClass
  ttl?: string | number
  swr?: string | number
  tags?: string[]
  consistency?: 'eventual' | 'strong'
}

/** What a slot may spend, in the spellings a person writes: `'120ms'`, `'8kb'`. */
export interface BudgetDeclaration {
  cpu?: string | number
  js?: string | number
  grow?: string | number
  onExceed?: ExceedPolicy
}

/**
 * A budget stated per request rather than per build.
 *
 * A budget is normally a plan declaration and should stay one: it is a promise about the shape of
 * a deployment, not a knob. The exception is a page whose subject *is* the budget — one that lets
 * you move it and watch what the exceed policy does.
 *
 * The plan keeps the declared values, so `weft why` and the build report still show a real
 * declaration and the ceiling a deployment states is the one it states. What varies is an
 * override on the slot this request resolved to, and only `cpu` and `onExceed` can vary — a JS
 * ceiling is about what was built, and nothing at request time can change that.
 */
export type BudgetFor = (request: { params: Record<string, string>; query: URLSearchParams }) => {
  cpu?: string | number
  onExceed?: ExceedPolicy
}

/**
 * A slot that is a fragment living somewhere else.
 *
 * The front door's half of composition, and it declares the same three things the plan layer's
 * `region()` builder does: whether this region crosses a boundary, what the shell was built
 * expecting it to serve, and what the reader gets when it is having a bad afternoon. What it
 * deliberately does not declare is *where* — a shell naming the tier would make rolling that region
 * a redeploy of every shell that names it, so the deployment says where in `weft.config.ts` and the
 * route says only that there is a boundary.
 */
export interface RegionDeclaration {
  /**
   * It crosses a deployment boundary, and what the shell expects to find on the other side.
   *
   * `true` declares the boundary and describes nothing, which is legal and expensive: an
   * undescribed region reads `opaque`, so the document containing it is uncacheable and private.
   * Unknown is not nothing.
   */
  remote?: boolean | RegionContract
  /** A fragment rendered in this region's place when it fails, by name under `app/fragments/`. */
  fallback?: string
  /** Failure is invisible: an empty hole and nobody paged. */
  optional?: boolean
  /** Directives this region needs. Merged into the document's one policy, and refused on conflict. */
  csp?: Record<string, readonly string[]>
  /** Shell signals this region reads. Checked against `defineRoute({ exposes })`. */
  consumes?: string[]
  /** Ours, and in the first flush. A remote region may not be critical: the flush cannot wait. */
  critical?: boolean
}

/** Everything a route says about one hole: what fills it, when it arrives, what it may spend. */
export interface SlotDeclaration {
  /**
   * Which fragment renders it, by name under `app/fragments/`. Omitted for the `body` slot,
   * which is the route's own file, and for a slot with `html`, which uses the framework's
   * one deliberately-unescaped fragment.
   */
  fragment?: string
  load?: RouteLoad
  /** Markup rather than content — a control panel, a readout. Goes through `raw()`, and says so. */
  html?: string | ((ctx: RenderContext, params: Record<string, string>) => string | Promise<string>)
  cache?: CacheDeclaration
  /** Streamed with an optional priority. `false` buffers, which derives in-order delivery. */
  stream?: boolean | { prio?: number }
  incremental?: boolean
  /**
   * Re-render this slot after a response rather than on a reader's request.
   *
   * A slot with a TTL has one request per period that pays for a render, and it is always
   * somebody's. `true` warms it whenever its entry is in the last fifth of its life; `'profile'`
   * leaves the decision to a measurement. It is speculation about a **clock** and not about a
   * reader — guessing where somebody will go next is what a staged route already does, paid for by
   * their own hover.
   */
  speculate?: boolean | 'profile'
  executor?: string
  budget?: BudgetDeclaration
  /** Overrides `budget`'s cpu ceiling and exceed policy for this request. See `BudgetFor`. */
  budgetFor?: BudgetFor
  /** Rendered while the slot is degraded. Without one a degraded slot is empty, which is honest. */
  placeholder?: string
  refresh?: string | number
  form?: { prefer?: WireForm; fallback?: WireForm }
  /** Data this slot depends on, by slot name. A slot merely nested inside another does not declare it. */
  needs?: string[]
  /**
   * Refreshable over the channel. The framework registers this slot with the hub under a key
   * derived from the route and the tags, so an intent that writes one of those tags produces a
   * STALE frame for exactly the connections showing it.
   */
  live?: boolean
  /** This slot is a region: a fragment that may render on another deployment. */
  region?: RegionDeclaration
}

/** What goes in the document head for this route. A function of the params, never of the request. */
export interface HeadDeclaration {
  title?: string
  description?: string
  meta?: Record<string, string>
}

/**
 * What a `.data.ts` default-exports.
 *
 * Read at build time, so every field here becomes part of the generated plan rather than a branch
 * taken per request — and every field is validated against what the compiler inferred.
 */
export interface RouteModule {
  /**
   * Which document wraps this page: `app/layouts/<name>.tsx`. Without one it is `app/layout.tsx`,
   * and a page whose layout declares different slot holes fills different holes — the plan is
   * generated per route, so nothing has to agree across them.
   */
  layout?: string
  head?: HeadDeclaration | ((params: Record<string, string>) => HeadDeclaration)
  /**
   * Extra values for the layout's own holes, beyond the six the framework always supplies.
   *
   * A layout is the application's file, so it may want values the framework has no opinion
   * about — a heading, a status, a breadcrumb. Declaring them here is what makes the
   * unfilled-hole check possible: a layout hole that neither the framework nor this object
   * supplies fails the build with the hole named, rather than rendering an empty box.
   */
  layoutValues?: Record<string, unknown> | ((params: Record<string, string>) => Record<string, unknown>)
  /** The `body` slot's values. */
  load?: RouteLoad
  cache?: CacheDeclaration
  /** What the document response advertises. Checked against the strictest class on the page. */
  document?: CacheDeclaration
  stream?: boolean | { prio?: number }
  incremental?: boolean
  /**
   * Re-render this page's body after a response rather than on a reader's request.
   *
   * A slot with a TTL has one request per period that pays for a render, and it is always
   * somebody's. `true` warms it whenever its entry is in the last fifth of its life; `'profile'`
   * leaves the decision to a measurement. It is speculation about a **clock** and not about a
   * reader — guessing where somebody will go next is what a staged route already does, paid for by
   * their own hover.
   */
  speculate?: boolean | 'profile'
  live?: boolean
  placeholder?: string
  executor?: string
  budget?: BudgetDeclaration
  budgetFor?: BudgetFor
  refresh?: string | number
  form?: { prefer?: WireForm; fallback?: WireForm }
  /**
   * Runs in phase A, where the envelope is still open — so a redirect here is a real redirect
   * rather than a mid-stream apology.
   */
  guard?: (ctx: EnvelopeContext) => boolean | Promise<boolean>
  /** Where a refusing guard sends the request. Without one it refuses with `status`. */
  redirect?: string
  status?: number
  /** The layout's other slot holes, filled per route. `body` is this file and cannot be redeclared. */
  slots?: Record<string, SlotDeclaration>
  maxConcurrency?: number
  /**
   * Delivery order, when it has to be a control rather than a consequence.
   *
   * Normally this is derived: a plan whose slots all buffer expresses no interest in arrival
   * order, and in-order costs no fill mechanism, so the cheaper answer is the derived one. A page
   * whose *subject* is the difference between the two orders is the exception, and it states the
   * order as a function of its own params — which is why the exception is a route parameter
   * rather than a query string the router cannot see.
   */
  order?: 'in-order' | 'out-of-order' | ((params: Record<string, string>) => 'in-order' | 'out-of-order')
  /**
   * Answer a conditional request for this page: a strong `ETag` over the bytes, and a 304 when the
   * reader already holds them.
   *
   * Declared rather than derived, because it costs the one property this framework is built on. An
   * entity tag is a digest of the entity and it has to be in the envelope — which is sealed before
   * the first body byte — so the only way to have one is to hold the whole response back until it
   * is complete. A page that streams cannot have an ETag, and a page that could have one is
   * trading time-to-first-byte for a revalidation that costs no body bytes at all.
   *
   * That trade is worth taking on a page whose slots all buffer anyway. It is never worth taking
   * silently, so declaring it on a route that streams is `E_ETAG_STREAMS` at build time rather than
   * a quietly slower page.
   */
  etag?: boolean
  /**
   * `false` when this page must not be resolved at build time, and why.
   *
   * The L0 tier is derived twice over — structurally from what the compiler saw, and empirically by
   * rendering the page under two requests that differ in everything the framework can vary. Between
   * them they catch almost everything. What they cannot catch is a loader, an `html` thunk or a
   * `head` function reading a query key the probe did not invent: `ctx.query('src')` returns
   * undefined under both probes, the bytes match, and the page is frozen into a file that ignores
   * the parameter it was written to read.
   *
   * So a route that knows it varies on something the probe cannot guess says so, and the build
   * refuses it as `L0_DECLARED` with this text as the reason. It is an opt-*out* rather than an
   * opt-in for the obvious reason: a page that forgot to declare it is a page whose author believed
   * the derivation, and the derivation is right nearly always.
   */
  static?: false
  /** Why this page is not a file. Required with `static: false`: a refusal with no reason is noise. */
  notStaticBecause?: string
  /**
   * The values each of this route's parameters can take, when they are a set the application knows.
   *
   * This is what makes a parameterised page a file. L0 refuses a pattern with a parameter because
   * there is no single URL a file could answer — but a route that says its `category` is one of two
   * things has two URLs, and each one can be rendered, proved invariant and written out. Nothing
   * infers the set: a list of categories is the application's knowledge, and a framework guessing at
   * it would be a framework writing files for URLs nobody asked for.
   *
   * Every parameter in the pattern has to be here, or the route is refused with the missing ones
   * named — a partial enumeration would silently write files for some URLs and leave the rest to the
   * kernel, which is the one outcome nobody could debug.
   */
  params?: Record<string, readonly string[]>
  /**
   * Extra value names to send to the browser.
   *
   * The framework already works out which values a client-owned derived expression reads and
   * sends exactly those — `qty * unitPrice` recomputed in the browser means `unitPrice` travels
   * and nothing else does. This is for a value the browser needs for a reason the template cannot
   * show, and everything not listed stays on the server, where a value with no reason to travel
   * belongs.
   *
   * Not to be confused with `exposes` below, which is one letter away and a different mechanism:
   * this decides which of a *slot's* values reach that slot's own client code, and that decides
   * which of the *shell's* values reach a region's.
   */
  expose?: string[]
  /**
   * Shell values this page offers its regions, by name — the design's `expose({ locale, cartCount })`.
   *
   * Deliberately the only channel between a shell and the regions inside it, and deliberately
   * declared rather than discovered: the value of a single channel is that it can be checked, so a
   * region declaring `consumes: ['locale']` on a page that exposes nothing is a build error rather
   * than a region reading a global that happens to exist on one page and not on another.
   *
   * A name here has to be a value the shell actually renders with, because that is what is sent —
   * the value at render time in the document, and a `SIGNAL` frame afterwards whenever it changes.
   */
  exposes?: string[]
}

/** Identity, typed. The build reads the object; nothing here runs on a request. */
export function defineRoute(route: RouteModule): RouteModule {
  return route
}
