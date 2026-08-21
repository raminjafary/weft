import {
  baseRenderId,
  deltaPayload,
  render,
  type DeltaPayload,
  type TemplateIR,
  type Values,
  type WireForm,
} from '../../ir/src/index.ts'
import { frame, type Frame } from '../../warp/src/index.ts'
import type { StorePort } from './ports.ts'

/**
 * Surgical updates without a stateful server.
 *
 * LiveView is the strongest prior art here and the one thing it structurally cannot do is
 * the whole opportunity: it holds the previous render in a process per connected user, so
 * a diff is computed per connection and can never be shared. Ten thousand users watching
 * one price list produce ten thousand identical diffs.
 *
 * Keep the render state on the client instead. The client names the base render it holds;
 * the server recovers that base from the store, recomputes, and emits the delta. Any
 * stateless isolate anywhere can serve it, and because the delta is a pure function of two
 * content-addressed states it is cacheable by exactly the machinery that already exists —
 * one computation, ten thousand deliveries.
 *
 * Every step degrades, which is what makes it deployable rather than clever.
 */
export interface Held {
  slot: string
  tpl: string
  base: string
}

export function parseHeld(f: Frame): Held[] {
  const out: Held[] = []
  for (const [slot, value] of Object.entries(f.header)) {
    if (typeof value !== 'string') continue
    const dash = value.lastIndexOf('-')
    if (dash <= 0) continue
    out.push({ slot, tpl: value.slice(0, dash), base: value.slice(dash + 1) })
  }
  return out
}

export function heldFrame(held: readonly Held[]): Frame {
  const header: Record<string, string> = {}
  for (const h of held) header[h.slot] = `${h.tpl}-${h.base}`
  return frame('HELD', header)
}

export interface FormChoice {
  form: WireForm
  /** Why this form and not a smaller one. Every downgrade here is a named, visible step. */
  reason: string
}

export interface FormInput {
  /** Forms the template can serve, derived by the compiler rather than declared. */
  available: readonly WireForm[]
  /** Forms this client accepted at negotiation. */
  accepted: readonly WireForm[]
  /** Does the client hold this template version. */
  resident: boolean
  /** Did the server recover the base render the client named. */
  baseRecovered: boolean
  prefer?: WireForm
  fallback?: WireForm
  /** Measured round trip. High RTT favours one payload over N chunk fetches. */
  rttMs?: number
}

/**
 * The degradation ladder, and it is two rungs rather than the design's three. The `data`
 * form was cut in IR 2.0.0 after measurement — 1% smaller after brotli and slower to apply
 * than `html` — so a client that holds the template but whose base render the server cannot
 * recover falls straight to `html` rather than to a projected value set. See
 * `spec/FINDINGS.md`.
 */
export function selectForm(input: FormInput): FormChoice {
  const can = (form: WireForm): boolean => input.available.includes(form) && input.accepted.includes(form)

  if (input.prefer && can(input.prefer)) {
    if (input.prefer !== 'delta' || (input.resident && input.baseRecovered)) {
      return { form: input.prefer, reason: `preferred by the plan` }
    }
  }

  if (input.resident && input.baseRecovered && can('delta')) {
    return { form: 'delta', reason: 'template resident and base recovered: only changed values travel' }
  }
  if (input.resident && !input.baseRecovered) {
    const fallback = input.fallback && can(input.fallback) ? input.fallback : 'html'
    return { form: fallback, reason: 'template resident but the base render was not in the store' }
  }
  if (!input.resident) {
    if (can('bundle') && (input.rttMs ?? 0) >= 100) {
      return { form: 'bundle', reason: 'template not resident and RTT is high: one round trip beats several' }
    }
    if (can('split') && (input.rttMs ?? 0) < 100) {
      return { form: 'split', reason: 'template not resident and RTT is low: parallel chunk fetches win' }
    }
  }
  return { form: 'html', reason: 'the floor: nothing has to be resident for markup to render' }
}

const utf8 = new TextEncoder()
const decoder = new TextDecoder()

export function baseKey(tpl: string, id: string): string {
  return `base:${tpl}:${id}`
}

/** A delta is named by the transition it encodes, which is what makes it shareable. */
export function deltaKey(tpl: string, from: string, to: string): string {
  return `delta:${tpl}:${from}->${to}`
}

export async function recordBase(store: StorePort, ir: TemplateIR, values: Values): Promise<string> {
  const id = baseRenderId(ir, values)
  await store.set(baseKey(ir.version, id), utf8.encode(JSON.stringify(values)), {
    class: 'shared',
    tags: [`tpl:${ir.version}`],
  })
  return id
}

export async function recoverBase(store: StorePort, tpl: string, id: string): Promise<Values | null> {
  const entry = await store.get(baseKey(tpl, id))
  if (!entry) return null
  try {
    return JSON.parse(decoder.decode(entry.value)) as Values
  } catch {
    return null
  }
}

export interface SurgicalInput {
  slot: string
  ir: TemplateIR
  /** The values this refresh produced. The base is what the client is holding. */
  next: Values
  held?: Held
  store: StorePort
  accepted: readonly WireForm[]
  resolve?: (version: string) => TemplateIR | undefined
  prefer?: WireForm
  fallback?: WireForm
  rttMs?: number
}

export interface SurgicalResult {
  frame: Frame
  choice: FormChoice
  /** Present only on the delta path. */
  delta?: DeltaPayload
  /** True when the delta came out of the store rather than being computed for this client. */
  memoized: boolean
  nextBase: string
}

/**
 * The whole flow, end to end: recover, recompute, diff, memoize, emit. The memoization is
 * the part that matters — the delta is keyed by the transition, not by the connection, so
 * the ten-thousandth client to make the same transition pays a store read.
 */
export async function surgicalRefresh(input: SurgicalInput): Promise<SurgicalResult> {
  const held = input.held
  const resident = Boolean(held && held.tpl === input.ir.version)
  const prev = resident && held ? await recoverBase(input.store, held.tpl, held.base) : null

  const choice = selectForm({
    available: input.ir.forms,
    accepted: input.accepted,
    resident,
    baseRecovered: prev !== null,
    ...(input.prefer ? { prefer: input.prefer } : {}),
    ...(input.fallback ? { fallback: input.fallback } : {}),
    ...(input.rttMs !== undefined ? { rttMs: input.rttMs } : {}),
  })

  const nextBase = await recordBase(input.store, input.ir, input.next)

  if (choice.form !== 'delta' || !prev || !held) {
    return {
      choice,
      memoized: false,
      nextBase,
      frame: frame(
        'HTML',
        { s: input.slot, tpl: input.ir.version, base: nextBase, form: choice.form, why: choice.reason },
        render(input.ir, input.next, input.resolve),
        true,
      ),
    }
  }

  const key = deltaKey(input.ir.version, held.base, nextBase)
  const cached = await input.store.get(key)
  if (cached) {
    const delta = JSON.parse(decoder.decode(cached.value)) as DeltaPayload
    return { choice, memoized: true, nextBase, delta, frame: deltaFrame(input.slot, delta, nextBase, choice) }
  }

  const delta = deltaPayload(input.ir, held.base, prev, input.next, input.resolve)
  await input.store.set(key, utf8.encode(JSON.stringify(delta)), {
    class: 'shared',
    tags: [`tpl:${input.ir.version}`],
  })
  return { choice, memoized: false, nextBase, delta, frame: deltaFrame(input.slot, delta, nextBase, choice) }
}

function deltaFrame(slot: string, delta: DeltaPayload, next: string, choice: FormChoice): Frame {
  return frame(
    'DELTA',
    { s: slot, tpl: delta.tpl, base: delta.base, next, why: choice.reason },
    utf8.encode(JSON.stringify(delta.changed)),
    true,
  )
}

/**
 * Invalidation travelling the other way. When a tag is invalidated the store names the keys
 * it dropped, and every open connection holding one of them is told — the client then
 * decides whether to refresh now, on next focus, or never. Push invalidation of
 * server-rendered regions without turning the application into a realtime app.
 */
export interface StaleRegistry {
  hold(connection: string, slot: string, key: string): void
  release(connection: string): void
  /** Frames to push, grouped by connection. */
  staleFor(keys: readonly string[], reason: string): Map<string, Frame[]>
  readonly connections: number
}

export function createStaleRegistry(): StaleRegistry {
  const byConnection = new Map<string, Map<string, string>>()

  return {
    get connections() {
      return byConnection.size
    },
    hold(connection, slot, key) {
      let slots = byConnection.get(connection)
      if (!slots) {
        slots = new Map()
        byConnection.set(connection, slots)
      }
      slots.set(slot, key)
    },
    release(connection) {
      byConnection.delete(connection)
    },
    staleFor(keys, reason) {
      const dropped = new Set(keys)
      const out = new Map<string, Frame[]>()
      for (const [connection, slots] of byConnection) {
        const frames: Frame[] = []
        for (const [slot, key] of slots) {
          if (dropped.has(key)) frames.push(frame('STALE', { s: slot, reason }))
        }
        if (frames.length) out.set(connection, frames)
      }
      return out
    },
  }
}
