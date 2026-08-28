import {
  baseRenderId,
  deltaPayload,
  render,
  type DeltaPayload,
  type PatchPayload,
  type TemplateIR,
  type Values,
  type WireForm,
} from '@weftjs/ir'
import { frame, HELD_ONLY, reservedHeader, type Frame } from '@weftjs/warp'
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

/** What a `HELD` frame says this client is holding: templates, and the base render per region. */
export function parseHeld(f: Frame): Held[] {
  const out: Held[] = []
  for (const [slot, value] of Object.entries(f.header)) {
    if (reservedHeader(slot) || typeof value !== 'string') continue
    const dash = value.lastIndexOf('-')
    if (dash <= 0) continue
    out.push({ slot, tpl: value.slice(0, dash), base: value.slice(dash + 1) })
  }
  return out
}

/**
 * What the client is showing, per slot — and, with `only`, that this is the whole of it.
 *
 * Without `only` a HELD frame adds to what the server believes, which is right for a client that
 * is telling it about one more region. It is wrong for a client that has *navigated*: slot names
 * belong to a page, so the previous page's `sidebar` would sit in the map forever, be refreshed
 * by a REFRESH that names no slots, and be told it was stale by an invalidation about a page
 * nobody is on. `only` says the client is somewhere else now and this is everything it holds.
 */
export function heldFrame(held: readonly Held[], options: { only?: boolean } = {}): Frame {
  const header: Record<string, string | boolean> = {}
  for (const h of held) header[h.slot] = `${h.tpl}-${h.base}`
  if (options.only) header[HELD_ONLY] = true
  return frame('HELD', header)
}

/** The form chosen, and why. Every downgrade is a named step rather than a silent fallback. */
export interface FormChoice {
  form: WireForm
  /** Why this form and not a smaller one. Every downgrade here is a named, visible step. */
  reason: string
}

/** Everything the choice depends on. Nothing here is a preference except `prefer` and `fallback`. */
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
  /**
   * The frame will carry an epoch, so it is held unpainted until a commit.
   *
   * `patch` is refused here, and it is the one form whose exclusion is about *when* rather than
   * what: a delta addresses a binding, which does not move, and a patch addresses a path and a
   * marker ordinal, which another epoch's commit can move under it. A stale address writes a
   * value into the wrong node, so a form that cannot be held is not offered for holding.
   */
  staged?: boolean
  /**
   * Whether this deployment included the patch encoder.
   *
   * A seam rather than a policy, for the reason stampede coalescing is one: the rung costs bytes
   * on every entry that carries the refresh path, and a deployment whose regions are all
   * projectable never reaches it. Without one the ladder has the rung missing and says so, which
   * is the difference between a degradation and a silence.
   */
  encodesPatch?: boolean
}

/**
 * The degradation ladder, and it is two rungs rather than the design's three. The `data`
 * form was cut in IR 2.0.0 after measurement — 1% smaller after brotli and slower to apply
 * than `html` — so a client that holds the template but whose base render the server cannot
 * recover falls straight to `html` rather than to a projected value set. See
 * `spec/FINDINGS.md`.
 */
export function selectForm(input: FormInput): FormChoice {
  const can = (form: WireForm): boolean =>
    input.available.includes(form) &&
    input.accepted.includes(form) &&
    !(form === 'patch' && (input.staged === true || input.encodesPatch !== true))
  /** Both surgical forms need the same two facts: this template, and the base it was rendered from. */
  const surgical = (form: WireForm): boolean =>
    form !== 'delta' && form !== 'patch' ? true : input.resident && input.baseRecovered

  if (input.prefer && can(input.prefer) && surgical(input.prefer)) {
    return { form: input.prefer, reason: `preferred by the plan` }
  }

  if (input.resident && input.baseRecovered && can('delta')) {
    return { form: 'delta', reason: 'template resident and base recovered: only changed values travel' }
  }
  /**
   * The rung the ladder was missing. A template whose values are not projectable — a `raw()`
   * value, an isolated instance, a `slot` hole — cannot serve a delta however much the client
   * holds, and used to fall the whole way to markup on every refresh. A patch addresses the DOM
   * structurally instead, so what travels is the holes that changed rather than the region.
   */
  if (input.resident && input.baseRecovered && can('patch')) {
    return {
      form: 'patch',
      reason: 'template resident and base recovered, values not projectable: changed markup travels',
    }
  }
  if (input.resident && input.baseRecovered && input.available.includes('patch') && !input.encodesPatch) {
    return {
      form: 'html',
      reason: 'patch is derivable and no encoder is bound: this deployment did not include the rung',
    }
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

/** Where a region's last render is held, so the next delta has something to be a delta against. */
export function baseKey(tpl: string, id: string): string {
  return `base:${tpl}:${id}`
}

/**
 * A surgical payload is named by the transition it encodes rather than by the connection that
 * asked, which is the whole of why one computation serves ten thousand clients. The form is in
 * the key because a delta and a patch of one transition are two different answers.
 */
export function payloadKey(form: 'delta' | 'patch', tpl: string, from: string, to: string): string {
  return `${form}:${tpl}:${from}->${to}`
}

/** A delta keyed by the transition it encodes — which is what lets one computation serve every client. */
export function deltaKey(tpl: string, from: string, to: string): string {
  return payloadKey('delta', tpl, from, to)
}

/**
 * How long a recovered base render and a memoized delta live.
 *
 * Both were written with no expiry, which for a shared store means every distinct value set ever
 * rendered accumulates forever. It looked harmless because `memoryStore` is byte-bounded and
 * evicts; a Redis or KV adapter would not.
 *
 * A TTL here is safe in a way a TTL on a cache entry is not: an expired base costs a **form**,
 * never correctness. The client names a base the server can no longer recover, `selectForm`
 * falls to `html`, and the page is right. So the ceiling can be short, and the only thing a
 * short one costs is delta hit rate.
 */
export interface RefreshTtl {
  /** Default fifteen minutes: long enough for an idle tab, short enough to bound the store. */
  baseMs?: number
  deltaMs?: number
}

/**
 * How long a base render and a memoised delta are kept.
 *
 * Fifteen minutes each, and configurable per deployment. A base nobody can recover means the next
 * refresh falls back to `html`, which is correct and larger — so this is a memory-for-bytes trade
 * rather than a correctness one.
 */
export const DEFAULT_REFRESH_TTL: Required<RefreshTtl> = {
  baseMs: 15 * 60_000,
  deltaMs: 15 * 60_000,
}

/** Remember the render a client is about to be shown, so its first refresh can be a delta. */
export async function recordBase(
  store: StorePort,
  ir: TemplateIR,
  values: Values,
  ttl: RefreshTtl = {},
): Promise<string> {
  const id = baseRenderId(ir, values)
  await store.set(baseKey(ir.version, id), utf8.encode(JSON.stringify(values)), {
    class: 'shared',
    ttlMs: ttl.baseMs ?? DEFAULT_REFRESH_TTL.baseMs,
    tags: [`tpl:${ir.version}`],
  })
  return id
}

/** The values behind the base render a client named, or nothing — in which case `html` it is. */
export async function recoverBase(store: StorePort, tpl: string, id: string): Promise<Values | null> {
  const entry = await store.get(baseKey(tpl, id))
  if (!entry) return null
  try {
    return JSON.parse(decoder.decode(entry.value)) as Values
  } catch {
    return null
  }
}

/** What a refresh needs to produce the smallest honest update for one region. */
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
  /** How long a base render and a memoized delta live. Expiry costs a form, never correctness. */
  ttl?: RefreshTtl
  /** The frame will carry an epoch. See `FormInput.staged`: a patch is not held. */
  staged?: boolean
  /**
   * The patch encoder, when this deployment includes it. `patchPayload` from `@weftjs/ir` is the
   * implementation; passing it is what puts the second rung on the ladder. See
   * `entry-patch.ts` for what it costs.
   */
  patch?: PatchEncoder
}

/**
 * How a patch is encoded, supplied rather than imported.
 *
 * A seam for a byte budget: written into this module the encoder took four watermarks past their
 * ceilings, so it arrives through here and is measured under `entry-patch.ts`. A deployment whose
 * regions are all projectable never imports it.
 */
export type PatchEncoder = (
  ir: TemplateIR,
  base: string,
  prev: Values,
  next: Values,
  resolve?: (version: string) => TemplateIR | undefined,
) => PatchPayload

/** The update, the form it took, and why that form — so a report can explain a large payload. */
export interface SurgicalResult {
  frame: Frame
  choice: FormChoice
  /** Present only on the delta path. */
  delta?: DeltaPayload
  /** Present only on the patch path. */
  patch?: PatchPayload
  /** True when the payload came out of the store rather than being computed for this client. */
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
    ...(input.staged !== undefined ? { staged: input.staged } : {}),
    encodesPatch: Boolean(input.patch),
  })

  const nextBase = await recordBase(input.store, input.ir, input.next, input.ttl ?? {})

  /**
   * The two surgical forms, on one path. They differ in what they encode and in nothing else:
   * both are a pure function of two content-addressed states, both are memoized under the
   * transition, and both degrade to markup when the pieces are not there. Two branches would be
   * two places for that to stop being true.
   */
  const surgicalForm = choice.form === 'delta' || choice.form === 'patch' ? choice.form : undefined
  const encode = surgicalForm === 'delta' ? deltaPayload : input.patch
  if (surgicalForm && encode && prev && held) {
    const { value, memoized } = await shared<DeltaPayload | PatchPayload>(
      input,
      payloadKey(surgicalForm, input.ir.version, held.base, nextBase),
      () => encode(input.ir, held.base, prev, input.next, input.resolve),
    )
    // The patch body carries its writes and its opaque paths, because a client applying one may
    // hold no copy of the template — everything it needs to find a node is in the frame.
    const body = value.form === 'delta' ? value.changed : { opaque: value.opaque, writes: value.writes }
    return {
      choice,
      memoized,
      nextBase,
      ...(value.form === 'delta' ? { delta: value } : { patch: value }),
      frame: payload(value.form === 'delta' ? 'DELTA' : 'PATCH', input.slot, value, nextBase, choice, body),
    }
  }

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

/**
 * Read it, or compute it and record it. One helper rather than a branch per form, because the
 * two are the same operation on the same key space: a payload named by the transition it encodes
 * is shared by every client making that transition, which is the whole argument for
 * content-addressing the design.
 */
async function shared<T>(
  input: SurgicalInput,
  key: string,
  compute: () => T,
): Promise<{ value: T; memoized: boolean }> {
  const cached = await input.store.get(key)
  if (cached) return { value: JSON.parse(decoder.decode(cached.value)) as T, memoized: true }
  const value = compute()
  await input.store.set(key, utf8.encode(JSON.stringify(value)), {
    class: 'shared',
    ttlMs: input.ttl?.deltaMs ?? DEFAULT_REFRESH_TTL.deltaMs,
    tags: [`tpl:${input.ir.version}`],
  })
  return { value, memoized: false }
}

/** A payload frame: which transition it encodes in the headers, the payload itself in the body. */
function payload(
  kind: 'DELTA' | 'PATCH',
  slot: string,
  of: { tpl: string; base: string },
  next: string,
  choice: FormChoice,
  body: unknown,
): Frame {
  return frame(
    kind,
    { s: slot, tpl: of.tpl, base: of.base, next, why: choice.reason },
    utf8.encode(JSON.stringify(body)),
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
  /**
   * The slots one connection holds under any of these keys.
   *
   * The same question `staleFor` answers, asked about one connection — and it exists because of the
   * connection `staleFor` is always asked to skip. A `STALE` is a note about a value that has gone
   * old, and the connection that ran the intent is excluded from it on the grounds that it is being
   * handed the new values instead. That is true only of the slots the intent named in `refresh`, so
   * an intent that declared its writes and nothing else left exactly one client stale: the one
   * whose reader had just pressed the button.
   */
  holding(connection: string, keys: readonly string[]): string[]
  readonly connections: number
}

/** Which connections hold which keys, so an invalidation reaches the pages that showed them. */
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
    holding(connection, keys) {
      const slots = byConnection.get(connection)
      if (!slots) return []
      const dropped = new Set(keys)
      return [...slots].filter(([, key]) => dropped.has(key)).map(([slot]) => slot)
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
