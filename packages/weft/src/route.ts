import type { Values } from '@weftjs/ir'
import type { EnvelopeContext, RegionContract, RenderContext } from '@weftjs/kernel'
import type { LoaderContext } from './context.ts'
import type { ExceedPolicy, PolicyClass, WireForm } from './types.ts'

/**
 * Where a slot's values come from. Its result is what the fragment renders with.
 *
 * `weft build` turns a route module into a `Plan` and a `RouteBindings`. What a route may and may
 * not declare — and why there is deliberately no cache key here — is `spec/plan/plan.md`.
 */
export type RouteLoad = (
  ctx: LoaderContext,
  params: Record<string, string>,
) => Values | Promise<Values> | Record<string, unknown> | Promise<Record<string, unknown>>

/** What a slot declares about being held. Checked against what its fragment reads — `spec/kernel/cache.md`. */
export interface CacheDeclaration {
  /** `public` or `private`. Checked against the class this slot's reads derive, never trusted. */
  class: PolicyClass
  /** How long an entry may be served. `'5m'`, `'1h'`, or milliseconds. Required wherever a fragment read the clock. */
  ttl?: string | number
  /** Stale-while-revalidate: how long past the TTL an entry may answer while it refreshes. Same spellings as `ttl`. */
  swr?: string | number
  /** What invalidates this. An intent that declares one of these tags drops this entry when it runs. */
  tags?: string[]
  /** What the bound store can honestly claim. Defaults to `eventual`; a slot needing `strong` is refused on a store that cannot promise it. */
  consistency?: 'eventual' | 'strong'
}

/** What a slot may spend, in the spellings a person writes: `'120ms'`, `'8kb'`. See `spec/kernel/budgets.md`. */
export interface BudgetDeclaration {
  /** CPU this slot may spend before the exceed policy applies. `'120ms'`, or milliseconds. */
  cpu?: string | number
  /** JavaScript this slot may add to the page. `'8kb'`, or bytes. A ceiling on what was *built*, which is why `budgetFor` cannot override it. */
  js?: string | number
  /** How much the ceiling above may grow before the build fails. A growth cap is a diff. */
  grow?: string | number
  /** What happens when the slot does not fit: `stale`, `client`, `fallback`, `placeholder` or `fail`. */
  onExceed?: ExceedPolicy
}

/**
 * A budget stated per request rather than per build, for a page whose subject *is* the budget.
 *
 * The plan keeps the declared values, so `weft why` and the build report still show a real
 * declaration. Only `cpu` and `onExceed` can vary — see `spec/kernel/budgets.md`.
 */
export type BudgetFor = (request: { params: Record<string, string>; query: URLSearchParams }) => {
  cpu?: string | number
  onExceed?: ExceedPolicy
}

/**
 * A slot that is a fragment living somewhere else.
 *
 * Declares that there is a boundary, never where the other side is: the deployment says where in
 * `weft.config.ts`. See `spec/kernel/composition.md`.
 */
export interface RegionDeclaration {
  /** It crosses a deployment boundary, and what the shell expects to find. `true` describes nothing, so the region reads `opaque`. */
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
   * which is the route's own file, and for a slot with `html`.
   */
  fragment?: string
  /**
   * Where this slot's values come from. Runs in phase B, after the envelope is sealed, so it cannot
   * redirect and cannot set a header — that is `guard`'s job.
   */
  load?: RouteLoad
  /** Markup rather than content — a control panel, a readout. Goes through `raw()`, and says so. */
  html?: string | ((ctx: RenderContext, params: Record<string, string>) => string | Promise<string>)
  /** How long this region may be held and what invalidates it. See `CacheDeclaration`. */
  cache?: CacheDeclaration
  /** Streamed with an optional priority. `false` buffers, which derives in-order delivery. */
  stream?: boolean | { prio?: number }
  /**
   * Re-render through this slot's own memo, so only the holes whose values moved cost bytes. Worth
   * it for a slot whose template is large and whose values mostly are not. See `spec/kernel/surgical.md`.
   */
  incremental?: boolean
  /**
   * Re-render this slot after a response rather than on a reader's request. `true` warms it in the
   * last fifth of an entry's life; `'profile'` leaves the decision to a measurement.
   *
   * Speculation about a clock, not about a reader — see `spec/kernel/locus.md`.
   */
  speculate?: boolean | 'profile'
  /**
   * Where this slot renders, by the name it is bound under in `weft.config.ts`.
   *
   * `inline` and `client` are always available; anything else has to be in `executors` there, or the
   * build fails with `E_UNKNOWN_EXECUTOR` and the slot named.
   */
  executor?: string
  /** What this slot may spend, and what happens when it does not fit. See `BudgetDeclaration`. */
  budget?: BudgetDeclaration
  /** Overrides `budget`'s cpu ceiling and exceed policy for this request. See `BudgetFor`. */
  budgetFor?: BudgetFor
  /** Rendered while the slot is degraded. Without one a degraded slot is empty, which is honest. */
  placeholder?: string
  /**
   * Re-render this slot on a clock while a reader is on the page. `'30s'`, or milliseconds. Only
   * does anything on a `live` slot: the refresh travels over the channel.
   */
  refresh?: string | number
  /**
   * Which encoding this slot's updates would rather use, and what to fall back to.
   *
   * A preference and not a choice — the form is negotiated per request, and every form of a
   * fragment produces identical bytes. See `spec/kernel/surgical.md`.
   */
  form?: { prefer?: WireForm; fallback?: WireForm }
  /** Data this slot depends on, by slot name. A slot merely nested inside another does not declare it. */
  needs?: string[]
  /**
   * Refreshable over the channel: the slot is registered with the hub under a key derived from the
   * route and the tags, so an intent writing one of those tags produces a STALE frame for exactly
   * the connections showing it.
   */
  live?: boolean
  /** This slot is a region: a fragment that may render on another deployment. */
  region?: RegionDeclaration
}

/** What goes in the document head for this route. A function of the params, never of the request. */
export interface HeadDeclaration {
  /** The document's `<title>`. */
  title?: string
  /** The `<meta name="description">`, and what a share card says. */
  description?: string
  /** Any other `<meta name=… content=…>` pair. `og:` and `twitter:` names are written as given. */
  meta?: Record<string, string>
}

/**
 * What a `.data.ts` default-exports.
 *
 * Read at build time, so every field here becomes part of the generated plan rather than a branch
 * taken per request — and every field is validated against what the compiler inferred.
 */
export interface RouteModule {
  /** Which document wraps this page: `app/layouts/<name>.tsx`. Without one it is `app/layout.tsx`. */
  layout?: string
  /**
   * The title, the description and any other meta tag, as a value or a function of the params.
   *
   * Never a function of the request: a head that varied per request would vary the document, whose
   * cache key is derived from what its fragments read.
   */
  head?: HeadDeclaration | ((params: Record<string, string>) => HeadDeclaration)
  /**
   * Extra values for the layout's own holes, beyond the six the framework always supplies. Declaring
   * them here is what makes the unfilled-hole check possible: a hole nothing supplies fails the build.
   */
  layoutValues?: Record<string, unknown> | ((params: Record<string, string>) => Record<string, unknown>)
  /** The `body` slot's values. */
  load?: RouteLoad
  /** The `body` slot's cache policy. Every other slot declares its own. See `CacheDeclaration`. */
  cache?: CacheDeclaration
  /** What the document response advertises. Checked against the strictest class on the page. */
  document?: CacheDeclaration
  /** The `body` slot's delivery. `false` buffers, which derives in-order delivery for the page. */
  stream?: boolean | { prio?: number }
  /** The `body` slot's incremental re-render. See `SlotDeclaration.incremental`. */
  incremental?: boolean
  /** Re-render this page's body after a response rather than on a reader's request. See `SlotDeclaration.speculate`. */
  speculate?: boolean | 'profile'
  /** The `body` slot is refreshable over the channel. See `SlotDeclaration.live`. */
  live?: boolean
  /** Rendered while the body is degraded. Without one a degraded body is empty, which is honest. */
  placeholder?: string
  /** Where the body renders. See `SlotDeclaration.executor`. */
  executor?: string
  /** What the body may spend, and what happens when it does not fit. See `BudgetDeclaration`. */
  budget?: BudgetDeclaration
  /** Overrides the body budget's cpu ceiling and exceed policy for this request. See `BudgetFor`. */
  budgetFor?: BudgetFor
  /** Re-render the body on a clock while a reader is on the page. See `SlotDeclaration.refresh`. */
  refresh?: string | number
  /** Which encoding the body's updates would rather use. See `SlotDeclaration.form`. */
  form?: { prefer?: WireForm; fallback?: WireForm }
  /**
   * Runs in phase A, where the envelope is still open — so a redirect here is a real redirect
   * rather than a mid-stream apology. See `spec/kernel/lifecycle.md`.
   */
  guard?: (ctx: EnvelopeContext) => boolean | Promise<boolean>
  /** Where a refusing guard sends the request. Without one it refuses with `status`. */
  redirect?: string
  /**
   * What a refusing guard answers with when there is no `redirect`. Defaults to 403. A real status
   * is available only because phase A runs before the first body byte promises a 200.
   */
  status?: number
  /** The layout's other slot holes, filled per route. `body` is this file and cannot be redeclared. */
  slots?: Record<string, SlotDeclaration>
  /**
   * Ceiling on concurrent slot renders for this page, overriding the deployment's own. For the one
   * page whose fan-out is different from the rest of the application.
   */
  maxConcurrency?: number
  /**
   * Delivery order, when it has to be a control rather than a consequence.
   *
   * Normally derived: a plan whose slots all buffer expresses no interest in arrival order. Stated
   * as a function of the params, because a query string the router cannot see would not do.
   */
  order?: 'in-order' | 'out-of-order' | ((params: Record<string, string>) => 'in-order' | 'out-of-order')
  /**
   * Answer a conditional request for this page: a strong `ETag` over the bytes, and a 304 when the
   * reader already holds them.
   *
   * Declared rather than derived, because an entity tag has to be in the envelope and so costs
   * streaming entirely. Declaring it on a route that streams is `E_ETAG_STREAMS` at build time —
   * the trade is worth taking on a page that buffers anyway, and never worth taking silently. See
   * `spec/kernel/cache.md`.
   */
  etag?: boolean
  /**
   * `false` when this page must not be resolved at build time, and why.
   *
   * An opt-*out*, because the L0 derivations are right nearly always. What they cannot catch is a
   * loader reading a query key the probe did not invent — see `spec/kernel/static.md`.
   */
  static?: false
  /** Why this page is not a file. Required with `static: false`: a refusal with no reason is noise. */
  notStaticBecause?: string
  /**
   * The values each of this route's parameters can take, when they are a set the application knows.
   * This is what makes a parameterised page a file.
   *
   * Nothing infers the set, and every parameter in the pattern has to be here or the route is
   * refused with the missing ones named. See `spec/kernel/static.md`.
   */
  params?: Record<string, readonly string[]>
  /**
   * Extra value names to send to the browser, beyond the ones a client-owned derived expression was
   * seen to read. Everything not listed stays on the server.
   *
   * Not `exposes` below: this decides which of a *slot's* values reach that slot's own client code.
   */
  expose?: string[]
  /**
   * Shell values this page offers its regions, by name.
   *
   * The only channel between a shell and the regions inside it, declared rather than discovered so
   * that a region's `consumes` can be checked against it. A name here has to be a value the shell
   * actually renders with. See `spec/kernel/composition.md`.
   */
  exposes?: string[]
}

/** Identity, typed. The build reads the object; nothing here runs on a request. */
export function defineRoute(route: RouteModule): RouteModule {
  return route
}
