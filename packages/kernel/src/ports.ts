import type { CacheClass } from '@weft/ir'
import type { Intent } from './intent.ts'

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

/** Thirteen ports are declared. Seven are load-bearing today; the rest refuse rather than pretend. */
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
]

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

export interface StoreEntry {
  value: Uint8Array
  meta: EntryMeta
}

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

export interface StorePort {
  readonly name: string
  readonly consistency: Consistency
  readonly maxValueBytes: number
  readonly coherence: Coherence
  readonly scope: Scope
  get(key: string): Promise<StoreEntry | null>
  set(
    key: string,
    value: Uint8Array | ReadableStream<Uint8Array>,
    meta: Omit<EntryMeta, 'storedAt'>,
  ): Promise<void>
  /** Tag to keys index. Returns the keys it dropped, so a caller can report rather than guess. */
  invalidate(tags: string[]): Promise<string[]>
  /** Stampede lease. A null return means somebody else holds it and this caller should wait or serve stale. */
  lease(key: string, ttlMs: number): Promise<Lease | null>
  /** `waitUntil` on Workers, a task queue on Node. Revalidation happens after the response, or not at all. */
  revalidateAfterResponse(task: () => Promise<void>): void
}

// ── flags ────────────────────────────────────────────────────────────────────────────

export type FlagValue = string | number | boolean

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

export interface RenderOutcome {
  slot: string
  bytes: Uint8Array
  /** Wall-clock, measured by the executor rather than reported by the job. */
  ms: number
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
  prio: number
  /** Slots whose results this one needs. Data dependency, never existence dependency. */
  needs: string[]
}

export interface SchedulerPort {
  readonly name: string
  /** Given one wave's worth of ready slots, decide what order to dispatch them in. */
  order(ready: SchedulableSlot[]): SchedulableSlot[]
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
}

// ── render ───────────────────────────────────────────────────────────────────────────

export interface RenderPort {
  readonly name: string
  render(slot: string, values: Record<string, unknown>): Promise<Uint8Array>
}

// ── the set ──────────────────────────────────────────────────────────────────────────

export interface RequestFacts {
  url: URL
  method: string
  headers: Headers
  cookies: Record<string, string>
  params: Record<string, string>
}

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
}

export function requestFacts(request: Request, params: Record<string, string> = {}): RequestFacts {
  return {
    url: new URL(request.url),
    method: request.method,
    headers: request.headers,
    cookies: parseCookies(request.headers.get('cookie')),
    params,
  }
}

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
