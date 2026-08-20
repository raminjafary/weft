export type Subscriber = () => void

export interface Signal<T> {
  (): T
  set(next: T): void
  subscribe(run: Subscriber): () => void
}

let batchDepth = 0
const pending = new Set<Subscriber>()

/**
 * The smallest graph that serves the wiring table: a value, its subscribers, and a batch
 * so that two writes in one turn produce one DOM write. Built on the shape of the TC39
 * Signals proposal so it can be deleted rather than migrated when that ships.
 */
export function signal<T>(initial: T): Signal<T> {
  let value = initial
  const subscribers = new Set<Subscriber>()

  const read = (() => value) as Signal<T>

  read.set = (next: T): void => {
    if (next === value) return
    value = next
    if (batchDepth > 0) {
      for (const run of subscribers) pending.add(run)
      return
    }
    for (const run of subscribers) run()
  }

  read.subscribe = (run: Subscriber): (() => void) => {
    subscribers.add(run)
    return () => subscribers.delete(run)
  }

  return read
}

export function batch(work: () => void): void {
  batchDepth++
  try {
    work()
  } finally {
    batchDepth--
    if (batchDepth === 0) {
      const runs = [...pending]
      pending.clear()
      for (const run of runs) run()
    }
  }
}
