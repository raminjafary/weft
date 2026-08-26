import type { CacheClass, Resolver, TemplateIR, Values } from '@weft/ir'
import type { Intent } from './intent.ts'
import type { Renderable } from './render-intent.ts'

/**
 * The ports. One active implementation each, and the kernel knows nothing else about the
 * outside world — no filesystem, no sockets, no `process`. Everything here is expressible
 * against the WinterTC Minimum Common Web API, which is what makes "runs on Workers" a
 * property of the kernel rather than a porting exercise.
 *
 * A port is not a plugin. There is exactly one implementation of each, it answers "who
 * does this job", and replacing it cannot change any invariant — cache keys are still
 * derived from effects, render is still read-only, the envelope still has two phases.
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

/**
 * How a tier learns that something it holds is now wrong. A process-local cache cannot be
 * addressed from outside, so without naming this the honest description of an L1 is "a
 * short buffer whose TTL you tune down until staleness stops hurting".
 */
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
 * Who can read this tier. `process` is an isolate-local map nobody outside can address;
 * `shared` is anything another process, another isolate, or a CDN can read.
 *
 * This is not the same question as consistency or coherence, and conflating them is how a
 * private entry ends up somewhere it can be served to the wrong person. A tiered store refuses
 * to write a private entry to a shared tier on the strength of exactly this field.
 */
export type Scope = 'process' | 'shared'

/**
 * Where rendered bytes are held, and what the deployment can honestly claim about them.
 *
 * The four readonly properties are the interesting half: consistency, coherence, scope and a value
 * ceiling are checked at build time, so a plan asking for `strong` against an eventual store is a
 * build error rather than a guarantee nobody keeps.
 */
export interface StorePort {
  readonly name: string
  readonly consistency: Consistency
  readonly maxValueBytes: number
  readonly coherence: Coherence
  readonly scope: Scope
  /**
   * `stale: true` asks for an entry past its TTL rather than nothing.
   *
   * There is exactly one caller entitled to ask: a slot whose declared degradation is `stale`,
   * whose render has just failed, and whose alternative is a placeholder. An expired entry **is**
   * the last good render, so this needs no second key and no second write — the price of stale is
   * paid only by the request that actually needs it.
   *
   * An entry that was *invalidated* is not recoverable this way and must not be. Expiry means "this
   * may be out of date"; invalidation means "this is known to be wrong", and serving known-wrong
   * bytes is worse than admitting the region is missing.
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
   * How far a *lease* is remembered, when that is not how far an entry travels.
   *
   * `scope` above answers "who can read what this holds", and a tiered store refuses to write a
   * private entry to a shared tier on the strength of it. A lease answers a different question — how
   * many processes agree that somebody already took this — and the two were the same field until
   * something needed them to differ.
   *
   * What needed it: replay. A nonce is spent by taking a lease nobody releases, so replay protection
   * is exactly as wide as the lease, and a deployment that wanted per-deployment single-use had to
   * make its whole *cache* shared to get it — which is a much larger decision, made for a reason that
   * has nothing to do with caching. Split, a process-local cache can take shared leases, which is
   * what `sharedLeases` in `@weft/adapters` does. Absent, it is `scope`, which is what every store
   * that has one answer for both means.
   */
  readonly leaseScope?: Scope
  /** `waitUntil` on Workers, a task queue on Node. Revalidation happens after the response, or not at all. */
  revalidateAfterResponse(task: () => Promise<void>): void
  /**
   * Run what `revalidateAfterResponse` collected.
   *
   * Optional because the two hosts differ in who calls it, and that difference is the whole reason
   * the queue exists. On Workers the platform is handed the promise — `ctx.waitUntil(store.drain())`
   * — and the isolate stays alive for it. On Node nobody is watching, so the front door drains after
   * the response is out. A store that collects tasks and has no way to run them is a store whose
   * revalidation silently never happens, which is what this being on the port rather than on one
   * adapter is meant to stop.
   */
  drain?(): Promise<void>
}

// ── flags ────────────────────────────────────────────────────────────────────────────

export type FlagValue = string | number | boolean

/**
 * Feature flags, and the one thing that makes them plannable: the complete axis set.
 *
 * A flag whose values are enumerable partitions the plan rather than branching inside a render, so
 * only the resolved branch is reachable and a value off the axis is refused rather than rendered.
 */
export interface FlagPort {
  readonly name: string
  /** Every reachable value of every flag. This is what turns a combinatorial space into an enumerable one. */
  axes(): Record<string, FlagValue[]>
  resolve(flag: string, request: RequestFacts): Promise<FlagValue> | FlagValue
}

// ── session ──────────────────────────────────────────────────────────────────────────

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
 * Where a render lives, as an address rather than as a function.
 *
 * This exists because of a problem the executor interface had from the start and that only
 * showed up when something tried to implement `pool`: `run` takes a closure, and **a closure
 * cannot cross a crash domain**. A worker thread, a separate isolate, a service binding and
 * another pod all need a name they can resolve on their own side. The four unimplemented
 * executor kinds were not unimplemented because they are hard; they were unimplemented because
 * the interface as written could only express same-thread execution.
 *
 * `props` is whatever the export needs, and it has to survive structured clone — which is a
 * real constraint on what a poolable fragment may take, and is why this is opt-in per slot
 * rather than the only way to describe a render.
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
  /**
   * Set when the slot can be named rather than only called. An executor that runs somewhere
   * else requires it and refuses by name without it — `E_JOB_NOT_ADDRESSABLE`.
   */
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
   * CPU this render actually consumed, where that is a separable quantity.
   *
   * Absent on the request thread, and absent honestly: several renders and the stream itself
   * interleave there, so a `cpuUsage` delta around one of them is a measurement of all of them. It
   * is present on an executor that gave the render a thread of its own — which is the same
   * property that makes a budget a limit rather than a report, because a thread can be stopped and
   * a thread's CPU can be attributed.
   */
  cpuMs?: number
  /** Set when the job was killed or threw. The slot degrades; the request does not fail. */
  failure?: { code: string; message: string }
}

/**
 * One method, and it collapses six mechanisms that are normally six unrelated subsystems:
 * same thread, a worker pool, a separate isolate, a service binding, another pod, or the
 * browser. The executor boundary is also the fault and budget boundary — a slot that blows
 * its CPU budget is killed and degrades, and the rest of the response is untouched.
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
   * Given one wave's worth of ready slots, decide what order to dispatch them in.
   *
   * A scheduler **reorders what it was handed**. It may not invent a slot, drop one, or return
   * something it was not given: the wave is the plan's, and a scheduler that could change its
   * membership would be a scheduler that can change what a page contains. The kernel passes its
   * own nodes through and reads the order back, so anything else would be discarded anyway.
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

// ── telemetry ────────────────────────────────────────────────────────────────────────

export interface TelemetryPort {
  readonly name: string
  mark(name: string, at: number): void
  measure(name: string, ms: number, attrs?: Record<string, string | number>): void
}

// ── transport ────────────────────────────────────────────────────────────────────────

export interface TransportPort {
  readonly name: string
  /**
   * 103 Early Hints. H2/H3 only, and an HTTP/1.1 client simply waits for the final
   * response — which is why this returns whether it actually went out rather than void.
   */
  earlyHints?(links: PreloadLink[]): Promise<boolean> | boolean
}

// ── coalescing ───────────────────────────────────────────────────────────────────────

/**
 * What runs a render that might be duplicated. The kernel supplies the key and the render and
 * knows nothing else: whether to take a lease, how long to wait for the holder, and whether
 * waiting means polling or a subscription are all properties of the store behind it.
 *
 * `waited` distinguishes "this render happened" from "somebody else's render was handed to me",
 * which is the difference the trace and every dashboard actually care about.
 */
export type Coalescer = (
  key: string,
  render: () => Promise<Uint8Array>,
) => Promise<{ bytes: Uint8Array; waited: boolean }>

// ── registry ─────────────────────────────────────────────────────────────────────────

/**
 * An opaque id to the thing it names. The client never carries the name of server code, so
 * something has to hold the mapping — and it is a port rather than a module-level map because
 * a build-time manifest, a live module graph and a remote service are all legitimate answers
 * and they have different failure modes.
 */
export interface Registry {
  readonly name: string
  intent(id: string): Promise<Intent | undefined> | Intent | undefined
  /** Every registered id. For `weft why`, and for refusing a build whose wiring names nothing. */
  intents(): readonly string[]
  /**
   * A region name to the deployment serving it. Optional, because a deployment that composes
   * nothing has no regions to resolve, and a registry that cannot answer refuses by name —
   * `E_NO_REGION_REGISTRY` — rather than being approximated by a table somewhere else.
   *
   * This is the indirection the design's topology rests on. A shell names a region; what is
   * behind that name is a registry entry, so rolling a region to a new revision is a registry
   * write rather than a shell redeploy — and a checked-in file, a KV namespace and a control
   * plane are all legitimate answers with different failure modes, which is what makes it a
   * port rather than a constant.
   */
  region?(name: string): Promise<RegionBinding | undefined> | RegionBinding | undefined
  /** Every region this registry can resolve. For a build report, and for `weft verify`. */
  regions?(): readonly string[]
  /**
   * An opaque id to a fragment a client may ask to have rendered — the design's module catalogue.
   *
   * The third question this port answers, and the one that makes "rendering as a service, by passing
   * component names over the wire" safe rather than alarming: the name on the wire is opaque and
   * derived, so it discloses no server code, and what is behind it is a registry entry rather than a
   * table compiled into the page — so an entry can be served by this process today and by a region on
   * another deployment tomorrow without the client knowing either way.
   *
   * Optional, and an absent implementation is `E_NO_CATALOGUE` rather than an empty catalogue. A
   * deployment that offers nothing renderable should refuse the question, not answer it with silence.
   */
  renderable?(id: string): Promise<Renderable | undefined> | Renderable | undefined
  /** Every renderable id. For a build report, and so a page can be told what it may ask for. */
  renderables?(): readonly string[]
}

/**
 * What a region's name resolves to: somewhere to run it, something to run, and what the shell
 * believes it will get back.
 *
 * The whole of the difference between the design's four topologies is in `executor`. A binding
 * naming `inline` is the monolith — the default, and the best-tested path, because it is the same
 * path every other slot takes. One naming `binding:` or `svc:` is a tier boundary, which is also a
 * crash domain and a place a budget becomes a deadline. Nothing above this has to know which.
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
   * A shared secret this region's deployment presents when it has something to tell the composite.
   *
   * Push invalidation stops at a tier boundary for a structural reason: the composite holds a
   * contract and the keys are the region's own, so a `STALE` about them has nobody to send. The
   * missing half is not a protocol, it is an *authority* — who may tell this composite that a
   * region it composes has gone stale. That is a deployment's decision, so it is a secret in a
   * deployment's config rather than a mechanism in a framework.
   *
   * Absent, the endpoint refuses by name. A composite that never configured one cannot be told
   * anything by anybody, which is the right default for something that reaches every open
   * connection showing that region.
   */
  staleSecret?: string
}

/**
 * What a region promises, as an id and a version.
 *
 * Cross-boundary contracts are not novel — Module Federation checks published types in CI. What
 * is checked here is narrower: the version the deployment is *actually serving right now*, stated
 * by the region itself in its own `REGION` frame, against what the shell was built expecting. CI
 * against a published type closes the window before a deploy; this closes the one after it.
 */
export interface RegionContract {
  id: string
  version: string
  /**
   * What the region's own compiler inferred it reads, in the same vocabulary a local fragment
   * uses — and this is the field that makes a composed page cacheable at all.
   *
   * A cache class here is still derived and never declared. The derivation happens on the other
   * side, where the code is, and the contract carries the *reads* rather than the conclusion: the
   * composite runs them through the same `cacheClassOf`, `varyOn` and `requiresTtl` as everything
   * else, so a region contributes to a document's `Vary` and to its strictest class exactly as a
   * slot does.
   *
   * Absent means unknown, and unknown is not the same as nothing: an undeclared region reads
   * `opaque`, which is uncacheable and private. A page that advertised itself as shareable on the
   * strength of a region nobody had described would be the leak this whole mechanism exists to
   * prevent.
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
 * Who turns a fragment and a value set into bytes.
 *
 * Naming the slot was not enough: one slot renders a different fragment on every route, so a
 * renderer that is handed only a name has to be told the route as well and then look up what the
 * plan already knows. The job carries the template.
 *
 * The default implementation is the IR renderer, and it is bound rather than assumed — which is
 * what makes `remote` in phase 9 another implementation of this port rather than a second render
 * path beside it.
 */
export interface RenderPort {
  readonly name: string
  render(job: RenderJobIR): Promise<Uint8Array> | Uint8Array
}

// ── config ───────────────────────────────────────────────────────────────────────────

/**
 * What this deployment was configured with, read through a port so nothing else has to know
 * whether that means an environment variable, a Worker binding, or a secrets manager.
 *
 * A setting is deliberately **not** a tracked read. Every read on `Reads` taints a fragment and
 * lands in its cache key; a setting is a property of the deployment rather than of the request,
 * so two requests that differ in nothing may not produce two entries — and a key that contained
 * a database URL would be a key nobody could safely log.
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
 * Where a loader's data comes from, named rather than anonymous.
 *
 * The framework never sees a loader — a `.data.ts` is application code the compiler does not
 * read — so a query is invisible to everything that would otherwise bound it. Running it through
 * a port gives back the three things that absence costs: a name in the telemetry, a deadline that
 * is somebody's decision rather than the database's default, and the tags the render depended on
 * recorded where an invalidation can be checked against them.
 *
 * Deliberately not a query language. What runs is the caller's function; this decides what
 * happens around it.
 */
export interface DbPort {
  readonly name: string
  query<T>(query: DbQuery, run: (signal: AbortSignal) => Promise<T>): Promise<T>
  /** Accesses this port has run, newest last. Read by the trace, never by a render. */
  observed?(): readonly { name: string; ms: number; tags: readonly string[]; failed?: boolean }[]
}

// ── deployment ───────────────────────────────────────────────────────────────────────

/**
 * Which build is answering, and where it is running.
 *
 * The reason this is a port rather than three environment variables read wherever they are
 * needed: every runtime spells them differently — a revision is `GIT_SHA` on one platform, a
 * deployment id on another, and nothing at all on a laptop — and a kernel that read the ambient
 * environment would stop being a kernel that runs on Workers.
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
 * How often one caller may do something, and the one decision this port exists to refuse to make.
 *
 * The design puts rate limiting in the authority tier and it belongs there — but it is the piece of
 * that tier a kernel cannot implement, because the whole question is *what a call is counted
 * against*. An address is wrong behind a proxy and wrong for mobile carriers. A session is wrong for
 * an unauthenticated API. A subject is wrong for the calls made before anybody signs in. Which of
 * the three is right is a property of the deployment, and a kernel picking one would be guessing
 * with a straight face.
 *
 * So an intent declares how much traffic it can take — that is its own business, and a mutation that
 * writes to a payment provider knows something the deployment does not. And the port decides who is
 * being counted. Neither half can be inferred from the other, which is why this is a port and not a
 * number in a config file.
 *
 * Unbound, an intent that declares a limit is `E_NO_RATE_LIMIT` rather than unlimited — the same
 * argument as an unchecked capability, one step further along: a limit nothing enforces reads as a
 * protection that is not there.
 */
export interface LimitPort {
  readonly name: string
  /**
   * Whether this call may proceed. Called before the signature is verified, because it is the
   * cheapest of the three checks and the one that protects the other two: a caller hammering with
   * forged tokens should be turned away before an Ed25519 verification is done on their behalf.
   */
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
 * What the port is told, which is exactly the three things the design says a limit can be counted
 * against and nothing else.
 *
 * Not the whole request, deliberately. A port handed `RequestFacts` could count against anything —
 * a path, a query string, the body — and a limit counted against something nobody can enumerate is
 * a limit nobody can reason about. An address, a session and a subject are the three; a header, a
 * cookie and `subject` are how each of them is reached, through the same tracked read surface a
 * fragment uses rather than around it.
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
 * Everything the kernel refuses to implement.
 *
 * Fourteen capabilities, of which the first four are required and the rest are absent-or-bound. A
 * port has one implementation at a time and swapping it changes *where* something happens; plugins
 * are the other axis and only ever add. The one thing neither may do is write a cache key.
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
 * The request, reduced to what a read may see.
 *
 * Deliberately not the `Request`: a render that could reach the whole thing could read something the
 * compiler never saw, and the cache key would then not describe the render.
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
