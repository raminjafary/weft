import type { Values } from '@weft/ir'
import type { EnvelopeContext, RenderContext } from '@weft/kernel'
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
  ctx: RenderContext,
  params: Record<string, string>,
) => Values | Promise<Values> | Record<string, unknown> | Promise<Record<string, unknown>>

export interface CacheDeclaration {
  class: PolicyClass
  ttl?: string | number
  swr?: string | number
  tags?: string[]
  consistency?: 'eventual' | 'strong'
}

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
}

export interface HeadDeclaration {
  title?: string
  description?: string
  meta?: Record<string, string>
}

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
   * Extra value names to send to the browser.
   *
   * The framework already works out which values a client-owned derived expression reads and
   * sends exactly those — `qty * unitPrice` recomputed in the browser means `unitPrice` travels
   * and nothing else does. This is for a value the browser needs for a reason the template cannot
   * show, and everything not listed stays on the server, where a value with no reason to travel
   * belongs.
   */
  expose?: string[]
}

/** Identity, typed. The build reads the object; nothing here runs on a request. */
export function defineRoute(route: RouteModule): RouteModule {
  return route
}
