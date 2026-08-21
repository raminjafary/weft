import type { ExecutorPort, RenderJob, RenderOutcome, TelemetryPort } from './ports.ts'

/**
 * Where a render executes, and what happens when it costs more than it was allowed.
 *
 * The executor boundary is also the fault and budget boundary, which is most of why
 * per-slot executors exist at all. A slot that blows its budget is killed and degrades;
 * nothing else on the page notices.
 */
export type ExceedPolicy = 'stale' | 'client' | 'fallback' | 'placeholder' | 'fail'

export interface SlotBudget {
  cpuMs?: number
  onExceed?: ExceedPolicy
}

/**
 * A CPU budget is only enforceable where a render can be preempted. JavaScript is
 * single-threaded, so on the request thread a budget can be checked between awaits and
 * nowhere else: a tight synchronous loop goes straight through it. That is a property of
 * the platform, so it is declared on the executor rather than hidden.
 */
export interface Preemptible {
  readonly preemptible: boolean
}

export type KernelExecutor = ExecutorPort & Preemptible

export const W_CPU_BUDGET_INLINE =
  'W_CPU_BUDGET_INLINE: cpu budgets are only enforceable on preemptible executors; this slot is inline. ' +
  'Move it to pool:, isolate, binding:, or svc: for a hard limit'

/**
 * The default, and the fastest thing for a cheap fragment. Abort is cooperative: the job
 * is handed a signal and is expected to check it, which is exactly as strong a guarantee
 * as the runtime can give here.
 */
export function inlineExecutor(telemetry?: TelemetryPort): KernelExecutor {
  return {
    name: 'inline',
    kind: 'inline',
    preemptible: false,
    async run(job) {
      return runWithBudget(job, telemetry, false)
    },
  }
}

/**
 * A stand-in for a genuinely separate crash domain: the job runs on a fresh macrotask, so
 * a synchronous render still blocks, but an abort at an await point actually takes effect
 * and the outcome is reported as preemptible. It is not a worker thread, and it does not
 * claim to be one.
 */
export function deferredExecutor(telemetry?: TelemetryPort): KernelExecutor {
  return {
    name: 'deferred',
    kind: 'pool',
    preemptible: true,
    async run(job) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      return runWithBudget(job, telemetry, true)
    },
  }
}

/** The slot is not rendered on the server at all. The island ships and the browser renders it. */
export function clientExecutor(): KernelExecutor {
  return {
    name: 'client',
    kind: 'client',
    preemptible: true,
    async run(job) {
      return {
        slot: job.slot,
        bytes: new Uint8Array(0),
        ms: 0,
        failure: { code: 'E_CLIENT_RENDER', message: 'rendered in the browser' },
      }
    },
  }
}

async function runWithBudget(
  job: RenderJob,
  telemetry: TelemetryPort | undefined,
  preemptible: boolean,
): Promise<RenderOutcome> {
  const controller = new AbortController()
  const started = performance.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  if (job.cpuBudgetMs !== undefined) {
    timer = setTimeout(() => controller.abort(new Error('E_CPU_BUDGET')), job.cpuBudgetMs)
  }

  try {
    const bytes = await job.run(controller.signal)
    const ms = performance.now() - started
    // A budget can be exceeded without the abort ever being observed, which is the whole
    // point of the inline caveat: report the breach either way.
    const over = job.cpuBudgetMs !== undefined && ms > job.cpuBudgetMs
    telemetry?.measure('slot.render', ms, { slot: job.slot, over: over ? 1 : 0 })
    if (over) {
      return {
        slot: job.slot,
        bytes,
        ms,
        failure: {
          code: 'E_CPU_BUDGET',
          message: preemptible
            ? `${job.slot} exceeded ${job.cpuBudgetMs}ms`
            : `${job.slot} exceeded ${job.cpuBudgetMs}ms on a non-preemptible executor, so it ran to completion anyway`,
        },
      }
    }
    return { slot: job.slot, bytes, ms }
  } catch (error) {
    const ms = performance.now() - started
    const code = controller.signal.aborted ? 'E_CPU_BUDGET' : 'E_SLOT_FAILED'
    telemetry?.measure('slot.render', ms, { slot: job.slot, failed: 1 })
    return {
      slot: job.slot,
      bytes: new Uint8Array(0),
      ms,
      failure: { code, message: error instanceof Error ? error.message : String(error) },
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export interface DegradeInput {
  slot: string
  policy: ExceedPolicy
  stale?: Uint8Array
  fallback?: Uint8Array
  placeholder?: Uint8Array
}

export class SlotError extends Error {
  code: string
  slot: string

  constructor(code: string, slot: string, message: string) {
    super(`${code} [${slot}] — ${message}`)
    this.name = 'SlotError'
    this.code = code
    this.slot = slot
  }
}

/**
 * What a breached budget actually produces. Every outcome here is visible: graceful
 * degradation that nobody can see is a quality regression that looks like nothing at all.
 */
export function degrade(input: DegradeInput, failure: { code: string; message: string }): Uint8Array {
  switch (input.policy) {
    case 'stale':
      if (input.stale) return input.stale
      return input.placeholder ?? new Uint8Array(0)
    case 'fallback':
      if (input.fallback) return input.fallback
      return input.placeholder ?? new Uint8Array(0)
    case 'client':
    case 'placeholder':
      return input.placeholder ?? new Uint8Array(0)
    case 'fail':
      throw new SlotError(failure.code, input.slot, failure.message)
  }
}
