import type { SchedulerPort } from '@weftjs/kernel'

/**
 * Who decides what runs first, and how much of it runs at once. `prioScheduler` is exactly the
 * behaviour that was already there, named as a port so a deployment can change it. See
 * `spec/kernel/ports.md`.
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
      // Name breaks the tie, so two runs of the same plan dispatch in the same order.
      return [...ready].sort((a, b) => (b.prio ?? 0) - (a.prio ?? 0) || a.name.localeCompare(b.name))
    },
  }
}

/** A ceiling and nothing else: the order a plan produced is kept exactly as it was. */
export function fifoScheduler(options: PrioSchedulerOptions = {}): SchedulerPort {
  return {
    name: 'fifo',
    maxConcurrency: options.maxConcurrency ?? 6,
    order: (ready) => ready,
  }
}
