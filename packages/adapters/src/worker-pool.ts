import { Worker } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type KernelExecutor, type RenderJob, type RenderOutcome, type TelemetryPort } from '@weft/kernel'

/**
 * A real worker pool, which is what makes `.budget({ cpu })` a limit rather than a report.
 *
 * The inline and deferred executors say so honestly: a tight synchronous loop goes straight
 * through a budget checked between awaits, because JavaScript is single-threaded. A worker is a
 * separate thread with its own event loop, so `terminate()` stops a render that is not
 * cooperating — mid-loop, mid-regex, mid-anything. That is the difference, and it is the only
 * reason to pay for a thread.
 *
 * Three consequences are stated rather than discovered.
 *
 * **A job must be addressable.** `ExecutorPort.run` takes a closure and a closure cannot cross
 * a thread boundary, so a slot without a `JobAddress` is refused by name rather than silently
 * run on the request thread — which would give a budget that looks enforced and is not.
 *
 * **A terminated worker is dead.** Killing a render costs the worker, so the pool replaces it.
 * A budget breach is therefore not free even when it degrades cleanly, and the replacement is
 * counted so it shows up as a cost rather than as a mystery latency.
 *
 * **Props must survive structured clone.** That is a real constraint on what a poolable
 * fragment may take, and it is why an address is opt-in per slot rather than the only way to
 * describe a render.
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

export interface WorkerPool extends KernelExecutor {
  /** Workers replaced because a job of theirs was killed. A budget breach is not free. */
  readonly replaced: number
  readonly size: number
  close(): Promise<void>
}

interface Pending {
  resolve(outcome: { bytes?: Uint8Array; error?: string }): void
  slot: string
}

interface Slot {
  worker: Worker
  /** The job this worker is on, if any. One at a time: see `worker-entry.ts`. */
  busy: Pending | null
  /**
   * Handed to a caller that has not posted its message yet. Without this the dispatch loop
   * hands one idle worker to every waiter it can see, because none of them has had a turn to
   * mark it busy — two jobs on one worker, and the second `busy` overwrites the first, and the
   * first request waits forever. A reservation is synchronous where becoming busy is not.
   */
  reserved: boolean
}

/**
 * The module a worker starts on, resolved by what is next to this file rather than by which of the
 * two it was written as.
 *
 * This package runs from source as often as from a build, and those are two different files: `.ts`
 * beside these sources, `.js` beside the compiled ones. A worker entry is resolved by the runtime
 * and not by a bundler, so a hard-coded extension is right in exactly one of the two cases — and
 * the case it was wrong in was the built one, where the pool could not start a worker at all and
 * reported it as the render failing. Every test imports these sources, so nothing noticed.
 */
export const WORKER_ENTRY = workerEntry(import.meta.url)

export function workerEntry(from: string): string {
  const ts = fileURLToPath(new URL('./worker-entry.ts', from))
  return existsSync(ts) ? ts : fileURLToPath(new URL('./worker-entry.js', from))
}

const ENTRY = WORKER_ENTRY

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
    const slot: Slot = { worker, busy: null, reserved: false }
    worker.on('message', (message: { id: number; bytes?: Uint8Array; error?: string }) => {
      const pending = slot.busy
      slot.busy = null
      slot.reserved = false
      pending?.resolve(
        message.error !== undefined
          ? { error: message.error }
          : { bytes: message.bytes ?? new Uint8Array(0) },
      )
      pump()
    })
    worker.on('error', (error: Error) => {
      replace(slot, error.message)
    })
    worker.unref()
    return slot
  }

  /**
   * Take a worker out of the pool and stand up a fresh one. The job it was running is settled
   * first: a terminated worker sends nothing, so anything still awaiting it would await
   * forever, and a budget that hangs the request is worse than no budget at all.
   */
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
    const settled = new Promise<{ bytes?: Uint8Array; error?: string }>((resolve) => {
      slot.busy = { resolve, slot: job.slot }
      slot.reserved = false
    })

    let timer: ReturnType<typeof setTimeout> | undefined
    let killed = false
    if (job.cpuBudgetMs !== undefined) {
      timer = setTimeout(() => {
        killed = true
        // The whole point. A cooperative signal cannot stop a synchronous loop; this can.
        replace(slot, 'E_CPU_BUDGET')
      }, job.cpuBudgetMs)
    }

    slot.worker.postMessage({
      id,
      module: job.address.module,
      export: job.address.export,
      ...(job.address.props !== undefined ? { props: job.address.props } : {}),
    })

    const result = await settled
    if (timer !== undefined) clearTimeout(timer)
    const ms = performance.now() - started

    if (killed) {
      options.telemetry?.measure('slot.render', ms, { slot: job.slot, over: 1 })
      return {
        slot: job.slot,
        bytes: new Uint8Array(0),
        ms,
        failure: {
          code: 'E_CPU_BUDGET',
          message: `${job.slot} exceeded ${job.cpuBudgetMs}ms and its worker was terminated`,
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
    options.telemetry?.measure('slot.render', ms, { slot: job.slot, over: 0 })
    return { slot: job.slot, bytes: result.bytes ?? new Uint8Array(0), ms }
  }

  return {
    name: 'pool',
    kind: 'pool',
    // The only executor in this codebase that can say this: a thread can be stopped
    // mid-instruction, so a budget on it is a limit rather than a report.
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
