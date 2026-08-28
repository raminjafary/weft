import type { CacheClass, Resolver, TemplateIR, Values } from '@weftjs/ir'
import type { Intent } from './intent.ts'
import type { Renderable } from './render-intent.ts'

/**
 * The ports. One active implementation each, and the kernel knows nothing else about the outside
 * world. A port is not a plugin: it answers "who does this job", and replacing it cannot change any
 * invariant. See `spec/kernel/ports.md`.
 */

export type PortName =
  | 'render'
  | 'store'
  | 'flags'
  | 'session'
  | 'transport'
  | 'scheduler'
  | 'assets'
  | 'telemetry'
  | 'executor'
  | 'registry'
  | 'config'
  | 'db'
  | 'deployment'
  | 'limits'

/** Fourteen ports are declared. None of them is approximated: an unbound one refuses by name. */
export const PORTS: readonly PortName[] = [
  'render',
  'store',
  'flags',
  'session',
  'transport',
  'scheduler',
  'assets',
  'telemetry',
  'executor',
  'registry',
  'config',
  'db',
  'deployment',
  'limits',
]

/** A port refusal, carrying which port and which code, so a caller branches on neither the text. */
export class PortError extends Error {
  code: string
  port: PortName

  constructor(code: string, port: PortName, message: string) {
    super(`${code} [${port}] — ${message}`)
    this.name = 'PortError'
    this.code = code
    this.port = port
  }
}

/** The body of a port that is declared and not bound. Refuses by name rather than approximating. */
export function unimplemented(port: PortName): never {
  throw new PortError('E_PORT_UNIMPLEMENTED', port, `no implementation of the ${port} port is bound`)
}

// ── store ────────────────────────────────────────────────────────────────────────────

export type Consistency = 'eventual' | 'strong'

/** How a tier learns that something it holds is now wrong. See `spec/kernel/ports.md`. */
export type Coherence = 'ttl' | 'generation' | 'pubsub' | 'tracking' | 'warp'

/** What the store knows about an entry besides its bytes. The class is the load-bearing field. */
export interface EntryMeta {
  /** The cache class the key was derived under. A private entry may never reach a shared tier. */
  class: CacheClass
  /** Milliseconds. Absent means the entry lives until it is invalidated or evicted. */
  ttlMs?: number
  tags?: string[]
  storedAt: number
  /** Bumped by the store on every invalidation, so a `generation` tier can detect staleness. */
  generation?: number
}

/** Bytes and what is known about them. Returned together because a class without bytes decides nothing. */
export interface StoreEntry {
  value: Uint8Array
  meta: EntryMeta
}

/** A held claim on a key, and the only thing you can do with it. Releasing twice is harmless. */
export interface Lease {
  key: string
  release(): void
}

/**
 * Who can read this tier. Not the same question as consistency or coherence — conflating them is
 * how a private entry ends up served to the wrong person.
 */
export type Scope = 'process' | 'shared'

/**
 * Where rendered bytes are held, and what the deployment can honestly claim about them. The four
 * readonly properties are checked at build time, so `strong` against an eventual store is a build
 * error rather than a guarantee nobody keeps.
 */
export interface StorePort {
  readonly name: string
  readonly consistency: Consistency
  readonly maxValueBytes: number
  readonly coherence: Coherence
  readonly scope: Scope
  /**
   * `stale: true` asks for an entry past its TTL rather than nothing — the one caller entitled to
   * ask is a slot whose degradation is `stale`. An *invalidated* entry is never recoverable this
   * way. See `spec/kernel/cache.md`.
   */
  get(key: string, options?: { stale?: boolean }): Promise<StoreEntry | null>
  set(
    key: string,
    value: Uint8Array | ReadableStream<Uint8Array>,
    meta: Omit<EntryMeta, 'storedAt'>,
  ): Promise<void>
  /** Tag to keys index. Returns the keys it dropped, so a caller can report rather than guess. */
  invalidate(tags: string[]): Promise<string[]>
  /** Stampede lease. A null return means somebody else holds it and this caller should wait or serve stale. */
  lease(key: string, ttlMs: number): Promise<Lease | null>
  /**
   * How far a *lease* is remembered, when that is not how far an entry travels. `scope` answers who
   * can read what this holds; this answers how many processes agree somebody took it — split for
   * replay protection. See `spec/kernel/authority.md`.
   */
  readonly leaseScope?: Scope
  /** `waitUntil` on Workers, a task queue on Node. Revalidation happens after the response, or not at all. */
  revalidateAfterResponse(task: () => Promise<void>): void
  /**
   * Run what `revalidateAfterResponse` collected. Optional: Workers hands the platform the promise,
   * Node's front door drains it after the response. See `spec/kernel/ports.md`.
   */
  drain?(): Promise<void>
}

// ── flags ────────────────────────────────────────────────────────────────────────────

export type FlagValue = string | number | boolean

/**
 * Feature flags, and the one thing that makes them plannable: the complete axis set. A flag whose
 * values are enumerable partitions the plan rather than branching inside a render.
 */
export interface FlagPort {
  readonly name: string
  /** Every reachable value of every flag. This is what turns a combinatorial space into an enumerable one. */
  axes(): Record<string, FlagValue[]>
  resolve(flag: string, request: RequestFacts): Promise<FlagValue> | FlagValue
}

// ── session ──────────────────────────────────────────────────────────────────────────

/**
 * Who is asking, and the cookies that say so. The one port whose reads change a cache key —
 * `identity` forces a private class. Writing is phase A only; the port returns cookies rather than
 * setting them.
 */
export interface SessionPort {
  readonly name: string
  /** Null for an anonymous request. Reading this taints `identity`, which forces a private class. */
  identity(request: RequestFacts): Promise<string | null> | string | null
  cookie(request: RequestFacts, key: string): string | undefined
  /**
   * Phase A only. Returns the cookies to write, if any — the port never touches the
   * envelope itself, because only the envelope knows whether it is still open.
   */
  rotateIfStale?(request: RequestFacts): Promise<SetCookie[]> | SetCookie[]
}

/** A cookie the envelope will write. Only phase A can produce one, which is the point of the type. */
export interface SetCookie {
  name: string
  value: string
  maxAge?: number
  path?: string
  domain?: string
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

// ── executor ─────────────────────────────────────────────────────────────────────────

export type ExecutorKind = 'inline' | 'pool' | 'isolate' | 'binding' | 'svc' | 'client'

/**
 * Where a render lives, as an address rather than as a function: a closure cannot cross a crash
 * domain, which is why `pool`, `isolate`, `binding` and `svc` need a name they can resolve on their
 * own side. See `spec/kernel/locus.md`.
 */
export interface JobAddress {
  module: string
  export: string
  props?: unknown
}

/** One slot's render, as an executor sees it: a budget, an optional address, and a function. */
export interface RenderJob {
  slot: string
  /** Milliseconds of CPU this slot is allowed before it is killed and degraded. */
  cpuBudgetMs?: number
  /** Set when the slot can be named rather than only called. Required off-thread — `E_JOB_NOT_ADDRESSABLE`. */
  address?: JobAddress
  run(signal: AbortSignal): Promise<Uint8Array>
}

/** What came back from an executor: the bytes, what they cost, and how the render ended. */
export interface RenderOutcome {
  slot: string
  bytes: Uint8Array
  /** Wall-clock, measured by the executor rather than reported by the job. */
  ms: number
  /**
   * CPU this render actually consumed, where that is separable. Absent on the request thread —
   * several renders interleave there. See `spec/kernel/locus.md`.
   */
  cpuMs?: number
  /** Set when the job was killed or threw. The slot degrades; the request does not fail. */
  failure?: { code: string; message: string }
}

/**
 * One method, collapsing six mechanisms into one: same thread, a worker pool, an isolate, a
 * binding, another pod, or the browser. Also the fault and budget boundary.
 */
export interface ExecutorPort {
  readonly name: string
  readonly kind: ExecutorKind
  run(job: RenderJob): Promise<RenderOutcome>
}

// ── scheduler ────────────────────────────────────────────────────────────────────────

export interface SchedulableSlot {
  name: string
  prio?: number
  /** Slots whose results this one needs. Data dependency, never existence dependency. */
  needs?: readonly string[]
}

/** Who decides the order within a wave, and how wide a wave may be. */
export interface SchedulerPort {
  readonly name: string
  /**
   * Given one wave's worth of ready slots, decide what order to dispatch them in. A scheduler
   * **reorders what it was handed** — it may not invent, drop or add a slot.
   */
  order<T extends SchedulableSlot>(ready: readonly T[]): readonly T[]
  /** Hard ceiling on concurrent renders per request. Forty parallel queries will melt a database. */
  readonly maxConcurrency: number
}

// ── assets ───────────────────────────────────────────────────────────────────────────

export interface PreloadLink {
  href: string
  as: 'script' | 'style' | 'font' | 'image' | 'fetch'
  crossOrigin?: boolean
  /** `modulepreload` for a module graph entry, `preload` for everything else. */
  rel: 'preload' | 'modulepreload'
}

/** What a route needs early: the links worth a 103, and the chunks a bundler would pack. */
export interface AssetPort {
  readonly name: string
  /** Emitted in the 103, before the envelope is settled. */
  criticalFor(route: string): PreloadLink[]
  chunksFor(route: string): string[]
}

// ── fanout ───────────────────────────────────────────────────────────────────────────

/**
 * Invalidation that crosses a process boundary. `hub.notify` alone is correct on exactly one
 * instance; on two, half the readers are told and half are not. `publish` must not deliver back to
 * the publisher — `origin` is for implementations that cannot suppress it. See `spec/kernel/transport.md`.
 */
export interface FanoutPort {
  readonly name: string
  /** An identity for this instance, so a message this process published is not acted on twice. */
  readonly origin: string
  /** Tell the other instances that these keys are known wrong. */
  publish(keys: readonly string[], reason: string): Promise<void>
  /**
   * Start delivering what other instances publish. A failure to subscribe throws rather than being
   * swallowed: believing you have cross-instance invalidation and not having it is worse than
   * knowing you have none.
   */
  subscribe(deliver: (keys: readonly string[], reason: string) => void): Promise<void>
  close?(): Promise<void>
}

// ── telemetry ────────────────────────────────────────────────────────────────────────

/**
 * Where the marks and the measures go. Two methods: an instant something happened, and how long
 * something took. The kernel measures whether or not one is bound.
 */
export interface TelemetryPort {
  readonly name: string
  mark(name: string, at: number): void
  measure(name: string, ms: number, attrs?: Record<string, string | number>): void
}

// ── transport ────────────────────────────────────────────────────────────────────────

/**
 * What the runtime underneath can do that the Fetch API cannot express. Small on purpose: `Request`
 * and `Response` cover everything else, and this is the exceptions.
 */
export interface TransportPort {
  readonly name: string
  /** 103 Early Hints. H2/H3 only; returns whether it actually went out rather than void. */
  earlyHints?(links: PreloadLink[]): Promise<boolean> | boolean
}

// ── coalescing ───────────────────────────────────────────────────────────────────────

/**
 * What runs a render that might be duplicated. The kernel supplies the key and the render; whether
 * to lease, how long to wait, and whether waiting polls are the store's. `waited` distinguishes a
 * render that happened from one handed to you.
 */
export type Coalescer = (
  key: string,
  render: () => Promise<Uint8Array>,
) => Promise<{ bytes: Uint8Array; waited: boolean }>

// ── registry ─────────────────────────────────────────────────────────────────────────

/**
 * An opaque id to the thing it names. A port rather than a module-level map: a build-time
 * manifest, a live module graph and a remote service are all legitimate answers.
 */
export interface Registry {
  readonly name: string
  intent(id: string): Promise<Intent | undefined> | Intent | undefined
  /** Every registered id. For `weft why`, and for refusing a build whose wiring names nothing. */
  intents(): readonly string[]
  /**
   * A region name to the deployment serving it. Optional — `E_NO_REGION_REGISTRY` rather than
   * approximated elsewhere. The indirection composition's topology rests on: a roll is a registry
   * write, not a shell redeploy. See `spec/kernel/composition.md`.
   */
  region?(name: string): Promise<RegionBinding | undefined> | RegionBinding | undefined
  /** Every region this registry can resolve. For a build report, and for `weft verify`. */
  regions?(): readonly string[]
  /**
   * An opaque id to a fragment a client may ask to have rendered — the design's module catalogue.
   * The name on the wire discloses no server code. `E_NO_CATALOGUE` rather than an empty one.
   */
  renderable?(id: string): Promise<Renderable | undefined> | Renderable | undefined
  /** Every renderable id. For a build report, and so a page can be told what it may ask for. */
  renderables?(): readonly string[]
}

/**
 * What a region's name resolves to. The whole difference between the design's four topologies is
 * in `executor`: `inline` is the monolith; `binding:`/`svc:` is a tier boundary and a crash domain.
 */
export interface RegionBinding {
  /** The name the shell used, which is the only name a client or a sibling region ever sees. */
  region: string
  /** The bound executor that reaches it. `inline` for a region this process renders itself. */
  executor: string
  /**
   * Module and export on the other side. Required by every executor that is not this thread,
   * for the reason `JobAddress` exists at all: a closure does not cross a crash domain.
   */
  address?: JobAddress
  /** The revision currently serving it. A roll is a write here, and it appears in the trace. */
  revision?: string
  /** What the shell expects this deployment to serve. A mismatch degrades rather than renders. */
  contract?: RegionContract
  /**
   * A shared secret this region's deployment presents to tell the composite it went stale. The
   * missing half is not a protocol, it is an authority — a deployment's decision. See `spec/kernel/composition.md`.
   */
  staleSecret?: string
}

/**
 * What a region promises, as an id and a version — the version actually serving right now, against
 * what the shell was built expecting. See `spec/kernel/composition.md`.
 */
export interface RegionContract {
  id: string
  version: string
  /**
   * What the region's own compiler inferred it reads — the field that makes a composed page
   * cacheable at all. Still derived, never declared. Absent reads `opaque`: uncacheable, private.
   * See `spec/kernel/composition.md`.
   */
  reads?: readonly string[]
}

// ── render ───────────────────────────────────────────────────────────────────────────

export interface RenderJobIR {
  slot: string
  template: TemplateIR
  values: Values
  /** Nested templates a hole names. Without it a list row or an instance renders nothing. */
  resolve?: Resolver
}

/**
 * Who turns a fragment and a value set into bytes. The job carries the template, since one slot
 * renders a different fragment on every route. Bound rather than assumed — `remote` is another
 * implementation of this port, not a second render path.
 */
export interface RenderPort {
  readonly name: string
  render(job: RenderJobIR): Promise<Uint8Array> | Uint8Array
}

// ── config ───────────────────────────────────────────────────────────────────────────

/**
 * What this deployment was configured with. A setting is deliberately **not** a tracked read — a
 * property of the deployment rather than of the request, so it never lands in a cache key.
 */
export interface ConfigPort {
  readonly name: string
  get(key: string): string | undefined
  /** A setting the deployment cannot run without: missing is refused by name, never defaulted. */
  required(key: string): string
  /** Every key this source can answer. A build that has to prove a setting exists asks here. */
  keys(): readonly string[]
}

// ── db ───────────────────────────────────────────────────────────────────────────────

export interface DbQuery {
  /** What this access is, for telemetry and for a trace somebody has to read at 3am. */
  name: string
  /** What it reads, in the vocabulary an intent invalidates with. */
  tags?: readonly string[]
  timeoutMs?: number
}

/**
 * Where a loader's data comes from, named rather than anonymous — the framework never sees a
 * `.data.ts` loader, so running its query through a port gives back a name, a deadline and tags.
 * Not a query language: what runs is the caller's function.
 */
export interface DbPort {
  readonly name: string
  query<T>(query: DbQuery, run: (signal: AbortSignal) => Promise<T>): Promise<T>
  /** Accesses this port has run, newest last. Read by the trace, never by a render. */
  observed?(): readonly { name: string; ms: number; tags: readonly string[]; failed?: boolean }[]
}

// ── deployment ───────────────────────────────────────────────────────────────────────

/**
 * Which build is answering, and where it is running. A port rather than environment variables read
 * ad hoc: every runtime spells them differently.
 */
export interface DeploymentPort {
  readonly name: string
  /** The build being served. `dev` where there is no build to name. */
  readonly revision: string
  readonly environment: string
  readonly region?: string
  /** This process or isolate, when the platform names one. */
  readonly instance?: string
}

// ── the set ──────────────────────────────────────────────────────────────────────────

export interface RequestFacts {
  url: URL
  method: string
  headers: Headers
  cookies: Record<string, string>
  params: Record<string, string>
}

// ── limits ───────────────────────────────────────────────────────────────────────────

/**
 * How often one caller may do something. The kernel cannot implement this: which of an address, a
 * session or a subject to count against is a deployment's decision, and the intent declares how
 * much traffic it can take. See `spec/kernel/authority.md`.
 */
export interface LimitPort {
  readonly name: string
  /** Whether this call may proceed. Called before the signature is verified — the cheapest check,
   * protecting the other two. */
  check(request: LimitRequest): Promise<LimitDecision> | LimitDecision
}

/** What an intent said about its own capacity. How much, over how long, and nothing about whom. */
export interface IntentLimit {
  /** Calls allowed inside the window. */
  max: number
  /** The window, in milliseconds. */
  windowMs: number
}

/**
 * What the port is told: exactly the three things a limit can be counted against, not the whole
 * request — a limit counted against anything is a limit nobody can reason about.
 */
export interface LimitRequest {
  /** The intent's opaque id, which is what travelled on the wire. */
  id: string
  /** Its declared name, for a message somebody has to read. */
  intent: string
  limit: IntentLimit
  /** The subject, when there is one. Resolved once here rather than by every implementation. */
  subject: string | null
  /** For counting against an address, which is a header behind every real proxy. */
  header(key: string): string | undefined
  /** For counting against a session, which is where an unauthenticated caller has an identity. */
  cookie(key: string): string | undefined
}

/** Whether a call is within its limit. A refusal says what it was counted against, for a log only. */
export type LimitDecision =
  | { ok: true; remaining?: number }
  | {
      ok: false
      /** What the call was counted against, for a log. Never for the caller: it identifies them. */
      counted: string
      /** Milliseconds until the window rolls, when the implementation can say. */
      retryAfterMs?: number
    }

/**
 * Everything the kernel refuses to implement. Fourteen capabilities; the first four are required
 * and the rest absent-or-bound. Neither a port nor a plugin may write a cache key.
 */
export interface Ports {
  store: StorePort
  flags: FlagPort
  session: SessionPort
  executors: Record<string, ExecutorPort>
  scheduler?: SchedulerPort
  assets?: AssetPort
  telemetry?: TelemetryPort
  transport?: TransportPort
  render?: RenderPort
  registry?: Registry
  config?: ConfigPort
  db?: DbPort
  deployment?: DeploymentPort
  limits?: LimitPort
}

/**
 * The request, reduced to what a read may see. Deliberately not the `Request`: a render that could
 * reach the whole thing could read something the compiler never saw.
 */
export function requestFacts(request: Request, params: Record<string, string> = {}): RequestFacts {
  return {
    url: new URL(request.url),
    method: request.method,
    headers: request.headers,
    cookies: parseCookies(request.headers.get('cookie')),
    params,
  }
}

/** A `Cookie` header as a map. Malformed pairs are skipped rather than throwing on a request. */
export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const key = part.slice(0, eq).trim()
    if (key) out[key] = decodeURIComponent(part.slice(eq + 1).trim())
  }
  return out
}

/** A `Set-Cookie` header value. Attributes are emitted in the order the RFC lists them. */
export function serializeCookie(c: SetCookie): string {
  const parts = [`${c.name}=${encodeURIComponent(c.value)}`]
  if (c.maxAge !== undefined) parts.push(`Max-Age=${c.maxAge}`)
  if (c.path) parts.push(`Path=${c.path}`)
  if (c.domain) parts.push(`Domain=${c.domain}`)
  if (c.httpOnly) parts.push('HttpOnly')
  if (c.secure) parts.push('Secure')
  if (c.sameSite) parts.push(`SameSite=${c.sameSite}`)
  return parts.join('; ')
}
