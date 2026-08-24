import { Worker } from 'node:worker_threads'
import { regionStream } from '@weft/kernel'
import { workerEntry } from './worker-pool.ts'
import type {
  JobAddress,
  KernelExecutor,
  RegionContract,
  RegionRequest,
  RenderJob,
  RenderOutcome,
  TelemetryPort,
} from '@weft/kernel'
import type { Frame } from '@weft/warp'

/**
 * The three executor kinds that were declared and had nothing behind them: `isolate`, `binding`
 * and `svc`.
 *
 * All three share the constraint the pool already made unavoidable. `ExecutorPort.run` takes a
 * closure and a closure does not cross a crash domain, so a slot without a `JobAddress` is refused
 * by name — `E_JOB_NOT_ADDRESSABLE` — rather than quietly run on the request thread, which would
 * give a budget that looks enforced and is not. Props must survive serialisation for the same
 * reason, and that is a real constraint on what a fragment may take rather than an inconvenience
 * to work around.
 *
 * What differs between them is what the other side *is*, and each difference costs something
 * stated rather than discovered.
 */
// The same entry the pool uses, resolved the same way — by what is actually next to this file,
// because running from source and running from a build are two different files.
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

export interface IsolateExecutorOptions {
  /** Resolves a relative module specifier in an address. Defaults to the adapters directory. */
  root?: string
  telemetry?: TelemetryPort
  /** The deadline a job gets when the slot declared no budget. */
  timeoutMs?: number
}

/**
 * One render, one isolate, and nothing carried between them.
 *
 * The difference from the pool is entirely in what is *not* shared: a fresh thread has an empty
 * module registry, so the first import of a template is paid on every render. That is the cost of
 * the guarantee — no state can leak from one render to the next, because there is nowhere for it
 * to live — and it is why this is the wrong default and the right answer for a fragment rendering
 * somebody else's untrusted template.
 *
 * Measured on this machine, same trivial render, fifteen samples each: a warm pool worker answers
 * in under a tenth of a millisecond, because the round trip is a `postMessage` and the module is
 * already loaded. A fresh isolate costs a p50 of **27.8 ms** (min 15.1) before it renders
 * anything. That is what the guarantee costs, and a slot on `isolate` is choosing to pay it.
 */
export function isolateExecutor(options: IsolateExecutorOptions = {}): KernelExecutor {
  const root = options.root ?? new URL('./', import.meta.url).href
  const timeoutMs = options.timeoutMs ?? 5_000

  return {
    name: 'isolate',
    kind: 'isolate',
    // A thread of its own, terminated when the budget is spent: the strongest thing an executor
    // can say, and it can only be said by something with its own stack.
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

          worker.on('message', (message: { bytes?: Uint8Array; error?: string }) => {
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
        // Unconditional: an isolate is per render by definition, so keeping one alive for a second
        // job would quietly turn this into a pool of one with none of a pool's accounting.
        await worker.terminate()
      }
    },
  }
}

/** What a service binding is, reduced to the one thing every platform's version of it has. */
export type BoundFetch = (request: Request) => Promise<Response> | Response

export interface BindingExecutorOptions {
  /**
   * The binding. On Workers this is `env.RENDERER.fetch`, on a mesh it is a client for the
   * sidecar, and in a test it is a function. It is a `fetch` because that is the one shape all of
   * them already have.
   */
  binding: BoundFetch
  /** Where the job is posted. Only meaningful to the other side. */
  path?: string
  timeoutMs?: number
  telemetry?: TelemetryPort
  name?: string
}

/**
 * A render on the other side of a binding: same datacentre, no network hop the deployment can
 * see, and a separate crash domain all the same.
 *
 * The honest limits are two. This cannot terminate the other side — a binding is a call, not a
 * thread — so the budget here is a deadline on *waiting*, and a render that ignores it goes on
 * running where it lives. And the wire is JSON, so what a slot may take is what survives it,
 * which is the same constraint the pool has for the same reason.
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

export interface SvcExecutorOptions {
  /** Where the renderer lives. Another pod, another region, another team's service. */
  url: string
  timeoutMs?: number
  telemetry?: TelemetryPort
  name?: string
  fetch?: typeof globalThis.fetch
}

/**
 * A render on another pod, over the network.
 *
 * Identical in shape to a binding and different in every failure mode: a network exists, so the
 * deadline is doing real work, and a slot on `svc` has to be one the page is honestly complete
 * without — the executor degrades cleanly, and a degraded region is what a reader sees when the
 * other end is having a bad afternoon.
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
 *
 * `preemption: 'at-await'` and not `'always'`, which is the whole reason this is written once and
 * carefully: the other side is a separate crash domain, so a *failure* there cannot take this
 * process down — but this end cannot stop it either. Aborting the request stops the waiting, not
 * the work. Claiming `'always'` would tell the plan that a CPU budget on such a slot is a limit,
 * and it is a limit on latency only.
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
 * The other side of a binding or a service, so a deployment does not have to write one to use
 * either — and so this repository can test both against something real rather than a mock.
 *
 * It is the worker entry's contract over HTTP: resolve a module and an export by name, call it
 * with the props, answer with bytes. Anything a `fetch` can reach can host it.
 */
export interface RenderServiceOptions {
  /** Resolves a relative module specifier. Defaults to the adapters directory. */
  root?: string
}

/**
 * Modules resolved by name and kept, because both services below answer many requests and the
 * first import is the expensive one. A fresh registry per render is what `isolate` is for, and it
 * is deliberately not what a service does.
 */
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
      // 500 rather than a thrown error: the caller degrades a slot on a bad status and hangs on a
      // socket that closed without one.
      return new Response((error as Error).message, { status: 500 })
    }
  }
}

/**
 * What a module has to export to be a region: the name it serves, and how to render it.
 *
 * `region` is here rather than taken from the request, and that is the whole security property.
 * The composer checks the name a region announces against the name it asked for, so a registry
 * entry pointing `search` at the recommendations deployment is refused — `E_REGION_ESCAPE` — by
 * the shell rather than rendered into the wrong hole. A service that echoed back whatever it was
 * asked would make that check unfalsifiable, which is the same class of mistake as a manifest
 * that spelled its own intent ids.
 */
export interface RegionRenderer {
  region: string
  contract?: RegionContract
  /** Frames for a client, or markup — which is announced as one `HTML` frame for this region. */
  render(request: RegionRequest): Promise<Frame[] | Uint8Array | string> | Frame[] | Uint8Array | string
}

export interface RegionServiceOptions {
  /** Resolves a relative module specifier. Defaults to the adapters directory. */
  root?: string
  /** The build answering, announced on every region it serves. */
  revision?: string
  /** Regions this service composes itself, so a nested tier is a tree rather than a special case. */
  hops?: number
}

/**
 * The other side of a composed region: the design's render tier, as something a `fetch` can reach.
 *
 * It is the same handler shape as `renderService` and answers a different thing — frames rather
 * than bytes — because a region is not markup. A region that only had markup to send could not
 * tell a client which templates it needs, which module to load, or that the client already holds
 * the template and should be given the changed values instead. The frames are the protocol the
 * composite already speaks to its client, which is the claim the design makes about tier
 * boundaries: there is no translation layer, because the internal protocol *is* the wire protocol.
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
      const result = await renderer.render(job.props ?? {})
      const frames = Array.isArray(result)
        ? result
        : [
            {
              kind: 'HTML' as const,
              header: { s: renderer.region },
              body: typeof result === 'string' ? utf8.encode(result) : result,
              bodyIsText: typeof result === 'string',
            },
          ]
      return new Response(
        regionStream(
          {
            region: renderer.region,
            hops: options.hops ?? 0,
            ...(renderer.contract ? { contract: renderer.contract } : {}),
            ...(options.revision ? { revision: options.revision } : {}),
          },
          frames,
        ) as BodyInit,
        { headers: { 'content-type': 'application/weft-warp' } },
      )
    } catch (error) {
      // A region that failed says so in its own frames rather than in a status, because the
      // composite degrades a region on a named reason and can only guess at a 500. The status is
      // 200 for the same reason an ERROR frame is not an exception: this answer is well-formed.
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
