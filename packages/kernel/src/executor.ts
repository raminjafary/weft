import type { ExecutorPort, RenderJob, RenderOutcome, TelemetryPort } from './ports.ts'

/**
 * Where a render executes, and what happens when it costs more than it was allowed. The executor
 * boundary is also the fault and budget boundary. See `spec/kernel/locus.md`.
 */
export type ExceedPolicy = 'stale' | 'client' | 'fallback' | 'placeholder' | 'fail'

/** What one slot may spend, and what happens when it does not fit. */
export interface SlotBudget {
  cpuMs?: number
  onExceed?: ExceedPolicy
}

/**
 * How far a render can be interrupted, which decides whether a CPU budget is a limit or a report.
 * Three states because a boolean could not tell the truth about `deferred`. See `spec/kernel/locus.md`.
 */
export type Preemption =
  /** Same task, no yield. A budget is a report. */
  | 'never'
  /** Yields first, so an abort lands at an await. A synchronous render still runs to completion. */
  | 'at-await'
  /** A separate crash domain that can be stopped mid-instruction. A budget is a limit. */
  | 'always'

/** Whether this executor can stop a render, which is what makes a CPU budget a limit. */
export interface Preemptible {
  readonly preemption: Preemption
}

/** An executor that also says whether it can be stopped. */
export type KernelExecutor = ExecutorPort & Preemptible

/** Whether a budget on this executor is a limit. Only a separate crash domain can promise one. */
export function isHardLimit(preemption: Preemption): boolean {
  return preemption === 'always'
}

/** Warned when a slot declares a CPU budget on an executor that cannot enforce it. */
export const W_CPU_BUDGET_ADVISORY =
  'W_CPU_BUDGET_ADVISORY: a cpu budget is only a hard limit on a separate crash domain, and this ' +
  'slot is not on one. The breach will be reported and the render will finish. ' +
  'Move it to pool:, isolate, binding:, or svc: for a limit that stops the work'

/**
 * The default, and the fastest thing for a cheap fragment. Abort is cooperative: the job
 * is handed a signal and is expected to check it, which is exactly as strong a guarantee
 * as the runtime can give here.
 */
export function inlineExecutor(telemetry?: TelemetryPort): KernelExecutor {
  return {
    name: 'inline',
    kind: 'inline',
    preemption: 'never',
    async run(job) {
      return runWithBudget(job, telemetry, 'never')
    },
  }
}

/**
 * A stand-in for a genuinely separate crash domain: the job runs on a fresh macrotask. Not a
 * worker thread, and does not claim to be one.
 */
export function deferredExecutor(telemetry?: TelemetryPort): KernelExecutor {
  return {
    name: 'deferred',
    // Not `pool`, which it claimed until a real pool existed: a macrotask boundary on the
    // request thread shares its kind with the thread it is on.
    kind: 'inline',
    preemption: 'at-await',
    async run(job) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      return runWithBudget(job, telemetry, 'at-await')
    },
  }
}

/** The slot is not rendered on the server at all. The island ships and the browser renders it. */
export function clientExecutor(): KernelExecutor {
  return {
    name: 'client',
    kind: 'client',
    // Vacuous: nothing is rendered on the server, so there is nothing to interrupt.
    preemption: 'always',
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

/**
 * What actually happened, for the two executors that run on the request thread. `always` is
 * absent: an executor that can stop a render writes its own message.
 */
const OVERRUN: Record<'never' | 'at-await', string> = {
  never: 'on an executor that cannot be interrupted, so it ran to completion anyway',
  'at-await': 'on an executor interruptible only at an await, so a synchronous render ran to completion',
}

async function runWithBudget(
  job: RenderJob,
  telemetry: TelemetryPort | undefined,
  preemption: 'never' | 'at-await',
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
    // A budget can be exceeded without the abort ever being observed: report the breach either way.
    const over = job.cpuBudgetMs !== undefined && ms > job.cpuBudgetMs
    telemetry?.measure('slot.render', ms, { slot: job.slot, over: over ? 1 : 0 })
    if (over) {
      return {
        slot: job.slot,
        bytes,
        ms,
        failure: {
          code: 'E_CPU_BUDGET',
          message: `${job.slot} exceeded ${job.cpuBudgetMs}ms ${OVERRUN[preemption]}`,
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

/** What a failed slot has to choose from: a placeholder, a fallback, a stale entry, or nothing. */
export interface DegradeInput {
  slot: string
  policy: ExceedPolicy
  stale?: Uint8Array
  fallback?: Uint8Array
  placeholder?: Uint8Array
}

/** A slot failure, carrying the code the degradation policy branches on. */
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

/** What a breached budget actually produces. Every outcome here is visible. */
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
