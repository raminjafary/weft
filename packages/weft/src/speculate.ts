import {
  createEnvelope,
  createReads,
  lifecycle,
  renderContext,
  requestFacts,
  resolveKey,
  type KernelRoute,
  type Ports,
  type StorePort,
} from '@weft/kernel'
import type { GeneratedRoute } from './routes.ts'

/**
 * `.speculate()`, which was recorded in the plan and read by nothing.
 *
 * What it means here: **do not make a reader pay for the miss.** A slot with a TTL has one request
 * per period that costs a render, and it is always somebody's request. A speculative slot is
 * re-rendered *after* a response instead — the reader who was going to wait gets a hit, and the
 * render happens on time the process has already finished charging to somebody.
 *
 * That is deliberately narrower than the word suggests. It is not prefetching a route nobody has
 * asked for and it is not rendering ahead on a guess about the next click; both are speculation
 * about a *reader*, and this framework has a better mechanism for that already — a staged route,
 * which the reader's own hover pays for. This is speculation about a *clock*, which is the half
 * the server actually knows.
 *
 * The work goes through `StorePort.revalidateAfterResponse`, so on Workers it is `waitUntil` and on
 * Node it is a queue the front door drains once the response is out. Before this, that queue had
 * nothing in it and nobody drained it.
 */
export interface SpeculationOptions {
  routes: readonly GeneratedRoute[]
  store: StorePort
  ports: Ports
  /** How close to expiry an entry has to be. 0.2 means the last fifth of its TTL. */
  window?: number
  /** Told what was warmed, so a deployment can see whether the mechanism is doing anything. */
  onWarmed?(pattern: string, slot: string, ms: number): void
}

export interface Speculation {
  /** Queue what this request implies, if anything. Returns the slots queued. */
  after(pattern: string, params: Record<string, string>, url: URL): Promise<string[]>
  /** Run the queue. On Node somebody has to; on Workers the platform does. */
  drain(): Promise<void>
  /** Patterns with at least one speculative slot, so a deployment can see the set. */
  readonly patterns: readonly string[]
}

const DEFAULT_WINDOW = 0.2

export function createSpeculation(options: SpeculationOptions): Speculation {
  /**
   * Which slots speculate, resolved once from the plan.
   *
   * `'profile'` is carried as its own mode rather than collapsed into `true`: it means *let a
   * measurement decide*, and the measurement is the recorder's own — a slot the profile has never
   * seen render is a slot nothing knows the cost of, and warming it on a guess is the kind of work
   * that looks like a feature and reads like a leak.
   */
  const speculative = new Map<string, { slots: string[]; profiled: Set<string> }>()
  for (const route of options.routes) {
    const slots: string[] = []
    const profiled = new Set<string>()
    for (const slot of route.plan.slots) {
      if (!slot.speculate) continue
      slots.push(slot.name)
      if (slot.speculate === 'profile') profiled.add(slot.name)
    }
    if (slots.length) speculative.set(route.pattern, { slots, profiled })
  }

  const byPattern = new Map(options.routes.map((route) => [route.pattern, route]))
  const window_ = options.window ?? DEFAULT_WINDOW
  const store = options.store as StorePort & { drain?(): Promise<void> }

  /** Whether this entry is close enough to expiry to be worth re-rendering now. */
  const nearingExpiry = (meta: { ttlMs?: number; storedAt: number } | undefined): boolean => {
    // No entry at all: a miss the next reader would pay for. Warm it.
    if (!meta) return true
    // No TTL: nothing expires, so nothing needs warming. It goes when it is invalidated, and an
    // invalidation is a different mechanism with a different answer.
    if (meta.ttlMs === undefined) return false
    const age = Date.now() - meta.storedAt
    return age >= meta.ttlMs * (1 - window_)
  }

  return {
    patterns: [...speculative.keys()],

    async after(pattern, params, url) {
      const declared = speculative.get(pattern)
      const route = byPattern.get(pattern)
      if (!declared || !route) return []

      const resolved: KernelRoute = await route.entry.value(params, url)
      const request = new Request(url)
      const facts = requestFacts(request, params)
      const queued: string[] = []

      for (const name of declared.slots) {
        const slot = resolved.slots.find((candidate) => candidate.name === name)
        if (!slot?.policy) continue
        const key = await resolveKey(
          { id: slot.id, version: slot.version, effects: slot.effects },
          facts,
          options.ports,
        )
        if (!key.key) continue
        const held = await options.store.get(key.key)
        if (!nearingExpiry(held?.meta)) continue

        queued.push(name)
        store.revalidateAfterResponse(async () => {
          const at = performance.now()
          const life = lifecycle()
          life.to('envelope')
          const envelope = createEnvelope(life)
          life.to('planned')
          envelope.seal()
          life.to('streaming')
          const bytes = await slot.render(renderContext(createReads(facts, options.ports), envelope))
          await options.store.set(key.key as string, bytes, {
            class: key.class,
            ...(slot.policy?.ttlMs !== undefined ? { ttlMs: slot.policy.ttlMs } : {}),
            ...(slot.policy?.tags ? { tags: slot.policy.tags } : {}),
          })
          options.onWarmed?.(pattern, name, performance.now() - at)
        })
      }
      return queued
    },

    async drain() {
      await store.drain?.()
    },
  }
}
