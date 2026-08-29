import { randomUUID } from 'node:crypto'
import type { FanoutPort } from '@weftjs/kernel'

/**
 * Cross-instance invalidation, in memory — the default, and the shape every other binding copies.
 * A Redis, Valkey or NATS binding replaces this without touching the hub. See `spec/kernel/transport.md`.
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
      // Copied before dispatch: a listener may unsubscribe another mid-iteration.
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
        // A publisher does not hear itself.
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
