import { Worker } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type KernelExecutor, type RenderJob, type RenderOutcome, type TelemetryPort } from '@weftjs/kernel'

/**
 * A real worker pool, which is what makes `.budget({ cpu })` a limit rather than a report: a
 * worker's own event loop lets `terminate()` stop a render mid-loop, mid-anything. A job must be
 * addressable, a terminated worker is replaced and counted, and props must survive structured
 * clone. See `spec/kernel/locus.md`.
 */
export interface WorkerPoolOptions {
  /** Threads. Defaults to four, which is a small number on purpose: renders are I/O-shaped more often than not. */
  size?: number
  /** Resolves a relative module specifier in an address. Defaults to the adapters directory. */
  root?: string
  telemetry?: TelemetryPort
  /** Milliseconds to wait for a worker to exit after `terminate()` before giving up on it. */
  drainMs?: number
}

/** A pool of worker threads, plus the shutdown a process has to perform. */
export interface WorkerPool extends KernelExecutor {
  /** Workers replaced because a job of theirs was killed. A budget breach is not free. */
  readonly replaced: number
  readonly size: number
  close(): Promise<void>
}

interface Pending {
  resolve(outcome: { bytes?: Uint8Array; error?: string; cpuMs?: number }): void
  slot: string
}

interface Slot {
  worker: Worker
  /** Called when the worker says the render itself has started. See `worker-entry.ts`. */
  rebaseline: (() => void) | null
  /** Modules this worker has already imported, so a budget is never charged for an import. */
  loaded: Set<string>
  /** Resolved when a preload comes back. */
  ready: (() => void) | null
  /** The job this worker is on, if any. One at a time: see `worker-entry.ts`. */
  busy: Pending | null
  /**
   * Handed to a caller that has not posted its message yet. Without this the dispatch loop hands
   * one idle worker to every waiter it can see, since none of them has marked it busy yet.
   */
  reserved: boolean
}

/**
 * The module a worker starts on, resolved by what is next to this file: `.ts` beside these
 * sources, `.js` beside the compiled ones. A hard-coded extension was wrong in the built case,
 * where the pool could not start a worker and reported it as the render failing.
 */
export const WORKER_ENTRY = workerEntry(import.meta.url)

/** The worker's own entry module, resolved from wherever the caller is. */
export function workerEntry(from: string): string {
  const ts = fileURLToPath(new URL('./worker-entry.ts', from))
  return existsSync(ts) ? ts : fileURLToPath(new URL('./worker-entry.js', from))
}

const ENTRY = WORKER_ENTRY

/** Renders on worker threads, which is what makes a CPU budget a limit rather than advisory. */
export function workerPool(options: WorkerPoolOptions = {}): WorkerPool {
  const size = options.size ?? 4
  const root = options.root ?? new URL('./', import.meta.url).href
  const queue: ((slot: Slot) => void)[] = []
  const workers: Slot[] = []
  let nextId = 1
  let replaced = 0
  let closed = false

  const spawn = (): Slot => {
    const worker = new Worker(ENTRY, { workerData: { root } })
    const slot: Slot = {
      worker,
      busy: null,
      reserved: false,
      rebaseline: null,
      loaded: new Set(),
      ready: null,
    }
    worker.on(
      'message',
      (message: { id: number; bytes?: Uint8Array; error?: string; cpuMs?: number; phase?: string }) => {
        // "The render is starting." Not a completion: the budget re-measures from here.
        if (message.phase === 'render') {
          slot.rebaseline?.()
          return
        }
        if (message.phase === 'loaded') {
          const ready = slot.ready
          slot.ready = null
          ready?.()
          return
        }
        const pending = slot.busy
        slot.busy = null
        slot.reserved = false
        pending?.resolve(
          message.error !== undefined
            ? { error: message.error }
            : {
                bytes: message.bytes ?? new Uint8Array(0),
                ...(message.cpuMs !== undefined ? { cpuMs: message.cpuMs } : {}),
              },
        )
        pump()
      },
    )
    worker.on('error', (error: Error) => {
      replace(slot, error.message)
    })
    worker.unref()
    return slot
  }

  /** Take a worker out of the pool and stand up a fresh one. The job it was running is settled first. */
  const replace = (slot: Slot, reason: string): void => {
    const pending = slot.busy
    slot.busy = null
    slot.reserved = false
    pending?.resolve({ error: reason })
    const index = workers.indexOf(slot)
    void slot.worker.terminate()
    if (closed || index < 0) return
    replaced++
    workers[index] = spawn()
    pump()
  }

  const pump = (): void => {
    while (queue.length) {
      const free = idle()
      if (!free) return
      free.reserved = true
      ;(queue.shift() as (slot: Slot) => void)(free)
    }
  }

  for (let i = 0; i < size; i++) workers.push(spawn())

  const idle = (): Slot | undefined => workers.find((w) => !w.busy && !w.reserved)

  async function run(job: RenderJob): Promise<RenderOutcome> {
    if (!job.address) {
      return {
        slot: job.slot,
        bytes: new Uint8Array(0),
        ms: 0,
        failure: {
          code: 'E_JOB_NOT_ADDRESSABLE',
          message: `${job.slot} has no address, and a closure cannot cross a thread boundary. Give the slot { module, export } or run it inline`,
        },
      }
    }
    if (closed) {
      return {
        slot: job.slot,
        bytes: new Uint8Array(0),
        ms: 0,
        failure: { code: 'E_POOL_CLOSED', message: 'the pool is closed' },
      }
    }

    const started = performance.now()
    const slot = await new Promise<Slot>((resolve) => {
      queue.push(resolve)
      pump()
    })

    const id = nextId++

    // Import first, then start the clock — only for a budgeted job, since only a budget cares.
    // See `spec/kernel/locus.md`.
    if (job.cpuBudgetMs !== undefined && !slot.loaded.has(job.address.module)) {
      await new Promise<void>((resolve) => {
        slot.ready = resolve
        slot.worker.postMessage({ id, module: (job.address as { module: string }).module, preload: true })
      })
      slot.loaded.add(job.address.module)
    }

    const settled = new Promise<{ bytes?: Uint8Array; error?: string; cpuMs?: number }>((resolve) => {
      slot.busy = { resolve, slot: job.slot }
      slot.reserved = false
    })

    // The budget, spent in CPU rather than wall clock: a render waiting on I/O uses almost none.
    // Polled at a quarter of the budget, floored so a tiny budget does not become a busy loop.
    // See `spec/kernel/locus.md`.
    let timer: ReturnType<typeof setInterval> | undefined
    let killed = false
    let spentMs = 0
    if (job.cpuBudgetMs !== undefined) {
      let baseline = slot.worker.performance.eventLoopUtilization()
      slot.rebaseline = () => {
        baseline = slot.worker.performance.eventLoopUtilization()
      }
      const every = Math.max(4, Math.min(25, Math.floor(job.cpuBudgetMs / 4)))
      timer = setInterval(() => {
        spentMs = slot.worker.performance.eventLoopUtilization(baseline).active
        if (spentMs <= (job.cpuBudgetMs as number)) return
        killed = true
        // A cooperative signal cannot stop a synchronous loop; this can.
        replace(slot, 'E_CPU_BUDGET')
      }, every)
      // A budget poll must not be the reason a process stays alive.
      timer.unref?.()
    }

    slot.worker.postMessage({
      id,
      module: job.address.module,
      export: job.address.export,
      ...(job.address.props !== undefined ? { props: job.address.props } : {}),
    })

    const result = await settled
    if (timer !== undefined) clearInterval(timer)
    slot.rebaseline = null
    const ms = performance.now() - started

    if (killed) {
      options.telemetry?.measure('slot.render', ms, { slot: job.slot, over: 1, cpu: Math.round(spentMs) })
      return {
        slot: job.slot,
        bytes: new Uint8Array(0),
        ms,
        cpuMs: spentMs,
        failure: {
          code: 'E_CPU_BUDGET',
          message: `${job.slot} spent ${Math.round(spentMs)}ms of CPU against a budget of ${job.cpuBudgetMs}ms, and its worker was terminated`,
        },
      }
    }
    if (result.error !== undefined) {
      options.telemetry?.measure('slot.render', ms, { slot: job.slot, failed: 1 })
      return {
        slot: job.slot,
        bytes: new Uint8Array(0),
        ms,
        failure: { code: 'E_SLOT_FAILED', message: result.error },
      }
    }
    options.telemetry?.measure('slot.render', ms, {
      slot: job.slot,
      over: 0,
      ...(result.cpuMs !== undefined ? { cpu: Math.round(result.cpuMs) } : {}),
    })
    return {
      slot: job.slot,
      bytes: result.bytes ?? new Uint8Array(0),
      ms,
      ...(result.cpuMs !== undefined ? { cpuMs: result.cpuMs } : {}),
    }
  }

  return {
    name: 'pool',
    kind: 'pool',
    // A thread can be stopped mid-instruction, so a budget on it is a limit, not a report.
    preemption: 'always',
    get replaced() {
      return replaced
    },
    get size() {
      return workers.length
    },
    run,
    async close() {
      closed = true
      queue.length = 0
      await Promise.all(workers.map((w) => w.worker.terminate()))
      workers.length = 0
    },
  }
}
