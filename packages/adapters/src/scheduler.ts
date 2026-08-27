import type { SchedulerPort } from '@weftjs/kernel'

/**
 * Who decides what runs first, and how much of it runs at once.
 *
 * The kernel already knew both answers and neither was anybody's to change: a wave's order was
 * priority and then name, decided inside `schedule()`, and the concurrency ceiling was a number
 * with a default. Naming them as a port is what makes them a deployment's decision — and the
 * default implementation is exactly the behaviour that was already there, so binding it changes
 * nothing and not binding it changes nothing either.
 *
 * The ceiling is the part that is not a preference. Forty concurrent queries from one page
 * request will melt a database, so the cap exists whether or not anyone tunes it, and the plan
 * warns at build time when a plan's widest wave exceeds it (`W_WAVE_WIDTH`).
 *
 * What a different implementation would be for: fair-share ordering across tenants, a ceiling
 * that moves with observed database latency, or a scheduler that starves optional slots when the
 * process is behind. All three are policy, which is why they are not in the kernel.
 */
export interface PrioSchedulerOptions {
  /** Defaults to six, which is the kernel's own default and the number the plan warns against. */
  maxConcurrency?: number
}

/** Orders a wave by declared priority. It reorders what it was handed and can add nothing. */
export function prioScheduler(options: PrioSchedulerOptions = {}): SchedulerPort {
  const maxConcurrency = options.maxConcurrency ?? 6
  return {
    name: 'prio',
    maxConcurrency,
    order(ready) {
      // Name breaks the tie, so two runs of the same plan dispatch in the same order and a
      // measurement of one is a measurement of the other.
      return [...ready].sort((a, b) => (b.prio ?? 0) - (a.prio ?? 0) || a.name.localeCompare(b.name))
    },
  }
}

/**
 * A ceiling and nothing else: the order a plan produced is kept exactly as it was.
 *
 * For a deployment whose slots are I/O-shaped and whose priorities are all zero, sorting is work
 * with no effect, and saying so is cheaper than pretending the order means something.
 */
export function fifoScheduler(options: PrioSchedulerOptions = {}): SchedulerPort {
  return {
    name: 'fifo',
    maxConcurrency: options.maxConcurrency ?? 6,
    order: (ready) => ready,
  }
}
