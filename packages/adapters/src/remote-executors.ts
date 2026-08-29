import { Worker } from 'node:worker_threads'
import { regionProbeStream, regionStream, treeHops } from '@weftjs/kernel'
import { workerEntry } from './worker-pool.ts'
import type {
  JobAddress,
  KernelExecutor,
  RegionContract,
  RegionNode,
  RegionRequest,
  RenderJob,
  RenderOutcome,
  TelemetryPort,
} from '@weftjs/kernel'
import type { Frame } from '@weftjs/warp'

/**
 * The three executor kinds that were declared and had nothing behind them: `isolate`, `binding`
 * and `svc`. All three refuse a slot with no `JobAddress` — `E_JOB_NOT_ADDRESSABLE` — since a
 * closure does not cross a crash domain. See `spec/kernel/locus.md`.
 */
// The same entry the pool uses, resolved the same way: running from source and from a build are
// two different files.
const ENTRY = workerEntry(import.meta.url)

function addressed(job: RenderJob, kind: string): JobAddress {
  if (!job.address) {
    throw new Error(
      `E_JOB_NOT_ADDRESSABLE: slot '${job.slot}' runs on ${kind}, which cannot receive a closure. ` +
        `Give its binding an address: { module, export }`,
    )
  }
  return job.address
}

function failed(job: RenderJob, ms: number, code: string, message: string): RenderOutcome {
  return { slot: job.slot, bytes: new Uint8Array(0), ms, failure: { code, message } }
}

/** A region in a separate isolate on this machine. */
export interface IsolateExecutorOptions {
  /** Resolves a relative module specifier in an address. Defaults to the adapters directory. */
  root?: string
  telemetry?: TelemetryPort
  /** The deadline a job gets when the slot declared no budget. */
  timeoutMs?: number
}

/**
 * One render, one isolate, and nothing carried between them: a fresh thread has an empty module
 * registry, so the first import is paid on every render — the cost of a guarantee that nothing
 * can leak between renders. Measured p50 27.8 ms. See `spec/kernel/locus.md`.
 */
export function isolateExecutor(options: IsolateExecutorOptions = {}): KernelExecutor {
  const root = options.root ?? new URL('./', import.meta.url).href
  const timeoutMs = options.timeoutMs ?? 5_000

  return {
    name: 'isolate',
    kind: 'isolate',
    // A thread of its own, terminated when the budget is spent — the strongest thing an executor
    // can say.
    preemption: 'always',
    async run(job) {
      const address = addressed(job, 'isolate')
      const started = performance.now()
      const worker = new Worker(ENTRY, { workerData: { root } })
      const budget = job.cpuBudgetMs ?? timeoutMs

      try {
        const outcome = await new Promise<RenderOutcome>((resolve) => {
          const timer = setTimeout(() => {
            resolve(
              failed(
                job,
                performance.now() - started,
                'E_CPU_BUDGET',
                `killed after ${budget}ms on its own isolate`,
              ),
            )
          }, budget)

          worker.on('message', (message: { bytes?: Uint8Array; error?: string; phase?: string }) => {
            // The worker says when the render starts; an isolate has no baseline to place from it.
            if (message.phase) return
            clearTimeout(timer)
            const ms = performance.now() - started
            if (message.error) {
              resolve(failed(job, ms, 'E_SLOT_FAILED', message.error))
              return
            }
            resolve({ slot: job.slot, bytes: message.bytes ?? new Uint8Array(0), ms })
          })
          worker.on('error', (error: Error) => {
            clearTimeout(timer)
            resolve(failed(job, performance.now() - started, 'E_SLOT_FAILED', error.message))
          })
          worker.postMessage({ id: 1, module: address.module, export: address.export, props: address.props })
        })
        options.telemetry?.measure('slot.render', outcome.ms, {
          slot: job.slot,
          executor: 'isolate',
          over: outcome.failure?.code === 'E_CPU_BUDGET' ? 1 : 0,
        })
        return outcome
      } finally {
        // Unconditional: an isolate is per render by definition.
        await worker.terminate()
      }
    },
  }
}

/** What a service binding is, reduced to the one thing every platform's version of it has. */
export type BoundFetch = (request: Request) => Promise<Response> | Response

/** A region over a platform binding — a real crash domain with no network in it. */
export interface BindingExecutorOptions {
  /** The binding — `env.RENDERER.fetch` on Workers, a sidecar client on a mesh. A `fetch` because that is the one shape all of them share. */
  binding: BoundFetch
  /** Where the job is posted. Only meaningful to the other side. */
  path?: string
  timeoutMs?: number
  telemetry?: TelemetryPort
  name?: string
}

/**
 * A render on the other side of a binding: same datacentre, no visible network hop, a separate
 * crash domain. Cannot terminate the other side, so the budget is a deadline on *waiting*. See
 * `spec/kernel/locus.md`.
 */
export function bindingExecutor(options: BindingExecutorOptions): KernelExecutor {
  return remoteExecutor({
    name: options.name ?? 'binding',
    kind: 'binding',
    post: (body, signal) =>
      Promise.resolve(
        options.binding(
          new Request(new URL(options.path ?? '/render', 'http://binding.local'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            signal,
          }),
        ),
      ),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.telemetry ? { telemetry: options.telemetry } : {}),
  })
}

/** A region over HTTP: where it lives, what it may spend, and what a failure degrades to. */
export interface SvcExecutorOptions {
  /** Where the renderer lives. Another pod, another region, another team's service. */
  url: string
  timeoutMs?: number
  telemetry?: TelemetryPort
  name?: string
  fetch?: typeof globalThis.fetch
}

/**
 * A render on another pod, over the network. Identical in shape to a binding, different in every
 * failure mode: a network exists, so the deadline does real work.
 */
export function svcExecutor(options: SvcExecutorOptions): KernelExecutor {
  const call = options.fetch ?? globalThis.fetch
  return remoteExecutor({
    name: options.name ?? 'svc',
    kind: 'svc',
    post: (body, signal) =>
      call(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal,
      }),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.telemetry ? { telemetry: options.telemetry } : {}),
  })
}

interface RemoteOptions {
  name: string
  kind: 'binding' | 'svc'
  post(body: string, signal: AbortSignal): Promise<Response>
  timeoutMs?: number
  telemetry?: TelemetryPort
}

/**
 * The half a binding and a service share, which is all of it except what `post` does.
 * `preemption: 'at-await'`, not `'always'`: aborting the request stops the waiting, not the work.
 * See `spec/kernel/locus.md`.
 */
function remoteExecutor(options: RemoteOptions): KernelExecutor {
  const timeoutMs = options.timeoutMs ?? 2_000

  return {
    name: options.name,
    kind: options.kind,
    preemption: 'at-await',
    async run(job) {
      const address = addressed(job, options.kind)
      const started = performance.now()
      const controller = new AbortController()
      const budget = job.cpuBudgetMs ?? timeoutMs
      const timer = setTimeout(() => controller.abort(), budget)

      const done = (outcome: RenderOutcome): RenderOutcome => {
        options.telemetry?.measure('slot.render', outcome.ms, {
          slot: job.slot,
          executor: options.name,
          over: outcome.failure?.code === 'E_CPU_BUDGET' ? 1 : 0,
        })
        return outcome
      }

      try {
        const response = await options.post(JSON.stringify({ slot: job.slot, ...address }), controller.signal)
        const ms = performance.now() - started
        if (!response.ok) {
          return done(failed(job, ms, 'E_SLOT_FAILED', `${options.kind} answered ${response.status}`))
        }
        return done({ slot: job.slot, bytes: new Uint8Array(await response.arrayBuffer()), ms })
      } catch (error) {
        const ms = performance.now() - started
        if (controller.signal.aborted) {
          return done(
            failed(
              job,
              ms,
              'E_CPU_BUDGET',
              `gave up waiting after ${budget}ms. The render may still be running on the other side, ` +
                `because a ${options.kind} can be abandoned and not killed`,
            ),
          )
        }
        return done(failed(job, ms, 'E_SLOT_FAILED', (error as Error).message))
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

/**
 * The other side of a binding or a service, so this repository can test both against something
 * real. The worker entry's contract over HTTP: resolve a module and export by name, call it,
 * answer with bytes.
 */
export interface RenderServiceOptions {
  /** Resolves a relative module specifier. Defaults to the adapters directory. */
  root?: string
}

/** Modules resolved by name and kept: both services below answer many requests, and the first import is the expensive one. */
function loader(root: string): (module: string) => Promise<Record<string, unknown>> {
  const loaded = new Map<string, Promise<Record<string, unknown>>>()
  return (module) => {
    let pending = loaded.get(module)
    if (!pending) {
      pending = import(module.startsWith('.') ? new URL(module, root).href : module) as Promise<
        Record<string, unknown>
      >
      loaded.set(module, pending)
    }
    return pending
  }
}

/** A handler that answers render requests for a catalogue, which is the far side of a region. */
export function renderService(options: RenderServiceOptions = {}): (request: Request) => Promise<Response> {
  const root = options.root ?? new URL('./', import.meta.url).href
  const load = loader(root)
  const utf8 = new TextEncoder()

  return async (request) => {
    try {
      const job = (await request.json()) as { module: string; export: string; props?: unknown }
      const exports = await load(job.module)
      const renderer = exports[job.export]
      if (typeof renderer !== 'function') {
        return new Response(`E_NO_SUCH_EXPORT: ${job.module} has no callable export ${job.export}`, {
          status: 422,
        })
      }
      const result = await (renderer as (props?: unknown) => unknown)(job.props)
      const bytes = typeof result === 'string' ? utf8.encode(result) : (result as Uint8Array)
      return new Response(bytes as BodyInit, { headers: { 'content-type': 'text/html' } })
    } catch (error) {
      // 500 rather than a thrown error: the caller degrades a slot on a bad status.
      return new Response((error as Error).message, { status: 500 })
    }
  }
}

/**
 * What a module has to export to be a region: the name it serves, and how to render it. `region`
 * is here rather than taken from the request — the whole security property, since a service that
 * echoed back whatever it was asked would make `E_REGION_ESCAPE` unfalsifiable. See `spec/kernel/composition.md`.
 */
export interface RegionRenderer {
  region: string
  contract?: RegionContract
  /**
   * Frames for a client, or markup, announced as one `HTML` frame. A region that composed regions
   * of its own returns `RegionAnswer` instead, with `composed` from its own composer — measured
   * rather than the hop count it was configured with.
   */
  render(
    request: RegionRequest,
  ): Promise<Frame[] | Uint8Array | string | RegionAnswer> | Frame[] | Uint8Array | string | RegionAnswer
  /**
   * What this region composes, answered without rendering it. The recursive half of
   * `weft verify --probe`. See `spec/kernel/composition.md`.
   */
  probe?(depth: number): Promise<readonly RegionNode[]> | readonly RegionNode[]
}

/** A render, plus what it took to produce — the shape a region that composes regions answers with. */
export interface RegionAnswer {
  frames?: readonly Frame[]
  /** Markup, when the region has no frames to send. Announced as one `HTML` frame for this region. */
  html?: Uint8Array | string
  /** The regions this render composed, as this region's own composer reported them. */
  composed?: readonly RegionNode[]
}

/** The other end: what a deployment serving regions needs to answer with Warp frames. */
export interface RegionServiceOptions {
  /** Resolves a relative module specifier. Defaults to the adapters directory. */
  root?: string
  /** The build answering, announced on every region it serves. */
  revision?: string
  /**
   * Boundaries this service crosses on its own account, for a region reaching something this
   * framework did not resolve. Declared rather than measured — the fallback for a region whose own
   * regions don't go through a composer.
   */
  hops?: number
}

/**
 * The other side of a composed region: the render tier, as something a `fetch` can reach. Same
 * handler shape as `renderService`, answering frames rather than bytes — the claim that the
 * internal protocol *is* the wire protocol. See `spec/kernel/composition.md`.
 */
export function regionService(options: RegionServiceOptions = {}): (request: Request) => Promise<Response> {
  const root = options.root ?? new URL('./', import.meta.url).href
  const load = loader(root)
  const utf8 = new TextEncoder()

  return async (request) => {
    let asked = '(unnamed)'
    try {
      const job = (await request.json()) as {
        slot?: string
        module: string
        export: string
        props?: RegionRequest
      }
      asked = job.slot ?? asked
      const exports = await load(job.module)
      const renderer = exports[job.export] as RegionRenderer | undefined
      if (!renderer || typeof renderer.render !== 'function' || typeof renderer.region !== 'string') {
        return new Response(
          `E_NOT_A_REGION: ${job.module}#${job.export} does not export { region, render }`,
          { status: 422 },
        )
      }
      const incoming = job.props ?? {}
      const identity = {
        region: renderer.region,
        ...(renderer.contract ? { contract: renderer.contract } : {}),
        ...(options.revision ? { revision: options.revision } : {}),
      }

      // Asked what it is rather than for a page: a probe that rendered would run every loader
      // behind it against a deployment nobody is serving traffic to yet. See `spec/kernel/composition.md`.
      if (incoming.probe) {
        const tree = renderer.probe ? await renderer.probe(incoming.probe.depth) : []
        return new Response(regionProbeStream({ ...identity, hops: treeHops(tree) }, tree) as BodyInit, {
          headers: { 'content-type': 'application/weft-warp' },
        })
      }

      const result = await renderer.render(incoming)
      const answer: RegionAnswer =
        Array.isArray(result) || result instanceof Uint8Array || typeof result === 'string'
          ? Array.isArray(result)
            ? { frames: result }
            : { html: result }
          : result
      const frames = answer.frames ?? [
        {
          kind: 'HTML' as const,
          header: { s: renderer.region },
          body:
            typeof answer.html === 'string' ? utf8.encode(answer.html) : (answer.html ?? new Uint8Array()),
          bodyIsText: typeof answer.html === 'string',
        },
      ]
      // The count and not the shape: a composite reading a page has no parser for a subtree, so a
      // graph only travels when the branch above asked for one.
      const composed = answer.composed ?? []
      return new Response(
        regionStream(
          { ...identity, hops: composed.length ? treeHops(composed) : (options.hops ?? 0) },
          frames,
        ) as BodyInit,
        { headers: { 'content-type': 'application/weft-warp' } },
      )
    } catch (error) {
      // A region that failed says so in its own frames rather than in a status: the composite
      // degrades on a named reason and can only guess at a 500.
      return new Response(
        regionStream({ region: asked, hops: options.hops ?? 0 }, [
          {
            kind: 'ERROR' as const,
            header: { s: asked, code: 'E_REGION_FAILED', reason: (error as Error).message },
          },
        ]) as BodyInit,
        { headers: { 'content-type': 'application/weft-warp' } },
      )
    }
  }
}
