import { randomUUID } from 'node:crypto'
import type { FanoutPort } from '@weftjs/kernel'

/**
 * Cross-instance invalidation, in memory — the default, and the shape every other one copies.
 *
 * A bus in a process is not cross-instance delivery, and this does not pretend to be: two hubs on
 * one bus are two hubs in one process. What it is for is the two cases that are real. A deployment
 * running one instance binds this and gets exactly what it had, with the wiring already in place
 * for the day it runs two. And a test can put two hubs on one bus and assert that an invalidation
 * handled by one reaches the connections held by the other — which is the property the port exists
 * for, and the one that cannot be tested at all without an implementation.
 *
 * A Redis, Valkey or NATS binding replaces this without touching the hub: the shape below is the
 * whole contract, and `origin` is the part that is easy to get wrong. A broker that echoes to the
 * publisher would have this process notify its own connections twice per write, so a message is
 * dropped when it carries the origin that sent it. Redis pub/sub does echo to a publisher on a
 * second connection, so a binding for it needs this and is not merely inheriting it.
 */
export interface FanoutBus {
  send(origin: string, keys: readonly string[], reason: string): void
  listen(listener: (origin: string, keys: readonly string[], reason: string) => void): () => void
}

/** One bus. Every port built on it hears what every other port on it publishes, and not itself. */
export function memoryBus(): FanoutBus {
  const listeners = new Set<(origin: string, keys: readonly string[], reason: string) => void>()
  return {
    send(origin, keys, reason) {
      // Copied before dispatch: a listener is allowed to unsubscribe when it hears something, and
      // one that unsubscribes another mid-iteration would otherwise decide who else gets told.
      for (const listener of Array.from(listeners)) listener(origin, keys, reason)
    },
    listen(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** What a memory fanout needs: a bus to talk on, and a name to not hear itself by. */
export interface MemoryFanoutOptions {
  /** Shared to make two ports talk to each other. Its own bus otherwise, which talks to nobody. */
  bus?: FanoutBus
  /** This instance's identity. Generated unless a deployment has a better name for itself. */
  origin?: string
}

/** A `FanoutPort` over a bus in this process. */
export function memoryFanout(options: MemoryFanoutOptions = {}): FanoutPort {
  const bus = options.bus ?? memoryBus()
  const origin = options.origin ?? randomUUID()
  let stop: (() => void) | undefined
  return {
    name: 'memory',
    origin,
    async publish(keys, reason) {
      if (!keys.length) return
      bus.send(origin, keys, reason)
    },
    async subscribe(deliver) {
      stop?.()
      stop = bus.listen((from, keys, reason) => {
        // The contract's one hard rule: a publisher does not hear itself. Without this the hub
        // that ran the write notifies its own connections a second time, and nothing downstream
        // can tell that from a second write having happened.
        if (from === origin) return
        deliver(keys, reason)
      })
    },
    async close() {
      stop?.()
      stop = undefined
    },
  }
}
