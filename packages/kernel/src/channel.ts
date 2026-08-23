import {
  clientView,
  TEMPLATE_IR_VERSION,
  type Resolver,
  type TemplateIR,
  type Values,
  type WireForm,
} from '@weft/ir'
import {
  bool,
  frame,
  HELD_ONLY,
  list,
  readResident,
  negotiate,
  str,
  warpFrame,
  type AnyFrame,
  type ClientHello,
  type Frame,
  WARP_FORMS,
  WARP_VERSION,
  type Negotiation,
  type ServerCapabilities,
} from '@weft/warp'
import { createEpochs, type Epochs, type Transition } from './epoch.ts'
import type { EnvelopeContext } from './context.ts'
import type { IntentDispatch, IntentOutcome } from './intent.ts'
import type { StorePort, TelemetryPort } from './ports.ts'
import {
  createStaleRegistry,
  parseHeld,
  surgicalRefresh,
  type Held,
  type RefreshTtl,
  type StaleRegistry,
} from './refresh.ts'

/**
 * The channel: one client, one Warp frame stream, and none of the three bindings.
 *
 * Everything phases 5 and 6 promise — a base render named by the client, a form chosen for
 * it, a delta memoized by its transition, epochs staged and committed atomically, push
 * invalidation travelling the other way — was reachable only from a test until this file
 * existed, because a frame that is produced and parsed but never carried is a data
 * structure rather than a protocol.
 *
 * What is here is binding-agnostic on purpose. A streamed response with discrete POSTs up,
 * an SSE stream, and a WebSocket differ in how bytes move and in nothing else, so they are
 * three `ChannelSink` implementations in `@weft/adapters` and one state machine here. The
 * differences that are real are named where they bite: SSE cannot carry binary, so it uses
 * text framing and pays base64 on bodies, and the streamed binding has no upstream at all,
 * so an upstream frame arriving with no live downstream is `E_NO_DOWNSTREAM` rather than a
 * silent drop.
 */
export type ChannelBinding = 'stream' | 'sse' | 'socket'

export interface ChannelSink {
  readonly binding: ChannelBinding
  /** False once the peer has gone. Sending to a closed sink is dropped and reported, never thrown. */
  readonly open: boolean
  /**
   * True when the transport's buffer is above its watermark — the peer is not reading as fast as
   * the server is writing. A sink that never reports this makes a slow consumer look like a fast
   * one right up to the point where the process runs out of memory holding frames for it.
   */
  readonly saturated?: boolean
  send(frames: readonly Frame[]): void | Promise<void>
  close(reason?: string): void
}

/** What a slot is, from the channel's point of view. Route knowledge, which a channel has none of. */
export interface SlotRender {
  ir: TemplateIR
  values: Values
  resolve?: Resolver
  /** The cache key this slot resolved to, so an invalidation can name the connections holding it. */
  key?: string
  prefer?: WireForm
  fallback?: WireForm
}

export interface SlotRequest {
  slot: string
  channel: Channel
}

export type SlotSource = (request: SlotRequest) => Promise<SlotRender | null> | SlotRender | null

export interface Channel {
  readonly id: string
  readonly binding: ChannelBinding
  /** Null until RESIDENT arrives. Every form decision needs it, so none of it is guessed. */
  readonly hello: ClientHello | null
  readonly negotiation: Negotiation | null
  readonly epochs: Epochs
  /** What the client holds per slot: updated by HELD, and by every refresh this channel serves. */
  readonly held: ReadonlyMap<string, Held>
  /** The last epoch this client reported committing. Set by RESUME. */
  readonly resumedAt: string | null
  readonly open: boolean
  /** Frames handed to the sink. A dropped send does not count. */
  readonly sent: number
  send(frames: readonly Frame[]): Promise<number>
  close(reason?: string): void
}

export interface HubOptions {
  store: StorePort
  source: SlotSource
  /**
   * What answers an INTENT frame. Optional, and its absence is `E_NO_INTENTS` rather than a
   * silent drop — an intent that vanishes looks to the client exactly like one that worked.
   */
  intents?: IntentDispatch
  /** The envelope context an intent runs against. A channel has no request, so the caller supplies one. */
  intentContext?(channel: Channel): EnvelopeContext | Promise<EnvelopeContext>
  /** Templates a WARM frame may ask for. Without one, WARM is refused by name. */
  templates?: (version: string) => TemplateIR | undefined
  server?: ServerCapabilities
  maxEpochs?: number
  /**
   * Consecutive saturated sends a channel may accumulate before it is closed as a slow
   * consumer. A channel is not a queue: frames held for a peer that is not reading are memory
   * the process cannot reclaim, and every one of them is stale by the time it would arrive.
   * Closing is the honest answer, and the client reconnects and asks for what it holds.
   */
  maxSaturatedSends?: number
  /** How long recovered base renders and memoized deltas live. Expiry costs a form, never correctness. */
  ttl?: RefreshTtl
  telemetry?: TelemetryPort
}

export interface ChannelHub {
  /**
   * Open a channel, or rebind an existing one. Rebinding is what resumption is: a webview
   * that was frozen and evicted reconnects under the same id and keeps the base renders it
   * was known to hold, so the server continues rather than treating it as a first visit.
   */
  open(sink: ChannelSink, id: string): Channel
  get(id: string): Channel | undefined
  /** Frames from a client, whatever binding carried them. Returns what went back down. */
  receive(id: string, frames: readonly AnyFrame[]): Promise<Frame[]>
  /**
   * Invalidate tags, then tell every open channel holding one of the dropped keys. The
   * client decides whether to refresh now, on next focus, or never — which is what makes
   * this push invalidation of server-rendered regions rather than a realtime application.
   */
  invalidate(tags: string[], reason?: string): Promise<{ keys: string[]; notified: number }>
  /**
   * Tell connections about keys something else already dropped. An intent invalidates through
   * its own declared-write guard, so by the time the channel sees the outcome the store is
   * already cold — and the connections holding those keys still have to be told. Without this
   * an invalidation that came from a mutation would notify nobody, which is the same bug as not
   * having push invalidation at all.
   */
  notify(keys: readonly string[], reason: string, options?: { except?: string }): Promise<number>
  close(id: string, reason?: string): void
  readonly channels: number
  readonly stale: StaleRegistry
}

export function createHub(options: HubOptions): ChannelHub {
  const stale = createStaleRegistry()
  const live = new Map<string, ChannelRecord>()
  const saturationLimit = options.maxSaturatedSends ?? 32

  interface ChannelRecord {
    channel: Channel
    sink: ChannelSink
    held: Map<string, Held>
    hello: ClientHello | null
    negotiation: Negotiation | null
    epochs: Epochs
    resumedAt: string | null
    sent: number
    /** Consecutive sends that left the transport above its watermark. */
    saturated: number
  }

  const hub: ChannelHub = {
    stale,
    get channels() {
      return live.size
    },

    open(sink, id) {
      const existing = live.get(id)
      if (existing) {
        existing.sink = sink
        return existing.channel
      }
      const record: ChannelRecord = {
        channel: undefined as unknown as Channel,
        sink,
        held: new Map(),
        hello: null,
        negotiation: null,
        epochs: createEpochs(options.maxEpochs),
        resumedAt: null,
        sent: 0,
        saturated: 0,
      }
      record.channel = {
        id,
        get binding() {
          return record.sink.binding
        },
        get hello() {
          return record.hello
        },
        get negotiation() {
          return record.negotiation
        },
        get epochs() {
          return record.epochs
        },
        get held() {
          return record.held
        },
        get resumedAt() {
          return record.resumedAt
        },
        get open() {
          return record.sink.open
        },
        get sent() {
          return record.sent
        },
        async send(frames) {
          if (!frames.length) return 0
          if (!record.sink.open) return 0
          await record.sink.send(frames)
          record.sent += frames.length
          if (record.sink.saturated) {
            record.saturated++
            if (record.saturated >= saturationLimit) {
              hub.close(id, 'E_SLOW_CONSUMER: the peer stopped reading')
              return frames.length
            }
          } else {
            record.saturated = 0
          }
          return frames.length
        },
        close(reason) {
          record.sink.close(reason)
          hub.close(id, reason)
        },
      }
      live.set(id, record)
      return record.channel
    },

    get(id) {
      return live.get(id)?.channel
    },

    close(id, reason) {
      const record = live.get(id)
      if (!record) return
      if (record.sink.open) record.sink.close(reason)
      stale.release(id)
      live.delete(id)
    },

    async receive(id, frames) {
      const record = live.get(id)
      if (!record) {
        throw new ChannelError('E_NO_SUCH_CHANNEL', `no channel ${id} is open`)
      }
      if (!record.sink.open) {
        throw new ChannelError(
          'E_NO_DOWNSTREAM',
          `channel ${id} has no live downstream, so an upstream frame has nowhere to be answered`,
        )
      }
      const out: Frame[] = []
      for (const f of frames) out.push(...(await handle(record, f)))
      await record.channel.send(out)
      return out
    },

    async invalidate(tags, reason = 'invalidated') {
      const keys = await options.store.invalidate(tags)
      const notified = await hub.notify(keys, reason)
      options.telemetry?.measure('channel.stale', notified, { tags: tags.join(',') })
      return { keys, notified }
    },

    async notify(keys, reason, opts = {}) {
      let notified = 0
      for (const [connection, frames] of stale.staleFor([...keys], reason)) {
        if (connection === opts.except) continue
        const record = live.get(connection)
        if (!record) continue
        notified += await record.channel.send(frames)
      }
      return notified
    },
  }

  async function handle(record: ChannelRecord, f: AnyFrame): Promise<Frame[]> {
    switch (f.kind) {
      case 'RESIDENT': {
        record.hello = readResident(f as Frame)
        record.negotiation = negotiate(record.hello, options.server ?? serverCapabilities())
        return [warpFrame(record.negotiation)]
      }

      case 'HELD': {
        /**
         * A client that says this is everything it holds is a client that has gone somewhere
         * else, and slot names belong to a page. Keeping the previous page's entries would
         * refresh regions nobody is looking at and hand this connection STALE frames about
         * them, so both the held map and what the stale registry believes it holds are dropped
         * before the new set is read.
         */
        if (bool(f, HELD_ONLY)) {
          record.held.clear()
          stale.release(record.channel.id)
        }
        for (const h of parseHeld(f as Frame)) record.held.set(h.slot, h)
        return []
      }

      case 'RESUME': {
        record.resumedAt = str(f, 'epoch') ?? null
        // Nothing is replayed: the client named what it holds and the held map survived the
        // rebind, so the next REFRESH produces a delta rather than a first render.
        return record.negotiation ? [warpFrame(record.negotiation)] : []
      }

      case 'WARM': {
        if (!options.templates) {
          return [errorFrame('E_NO_TEMPLATE_REGISTRY', 'this hub was given no template registry')]
        }
        const out: Frame[] = []
        for (const version of list(f, 'tpl')) {
          const ir = options.templates(version)
          if (!ir) {
            out.push(errorFrame('E_NO_SUCH_TEMPLATE', version))
            continue
          }
          out.push(frame('TPL', { tpl: ir.version }, utf8.encode(JSON.stringify(clientView(ir))), true))
        }
        return out
      }

      case 'REFRESH':
        return refresh(record, f)

      case 'INTENT':
        return intent(record, f)

      default:
        return [errorFrame('E_UNEXPECTED_FRAME', `${f.kind} is not something a channel acts on`)]
    }
  }

  /**
   * One INTENT: dispatch it, tell the client what happened, and refresh what the mutation
   * says it changed.
   *
   * The epoch is the whole reason this is worth doing over a channel rather than over a POST.
   * A client that staged an optimistic update under `o-3` sends `epoch=o-3`; on success the
   * refreshed slots are staged into that same epoch and one COMMIT replaces the optimistic
   * values with the real ones in a single paint. On failure the ACK carries `ok=false` and the
   * client discards the epoch — which is why rollback needs no frame of its own and no
   * reconstruction of prior state.
   */
  async function intent(record: ChannelRecord, f: AnyFrame): Promise<Frame[]> {
    const id = str(f, 'i')
    if (!id) return [errorFrame('E_INTENT_UNNAMED', 'an INTENT frame must carry i=<id>')]
    if (!options.intents || !options.intentContext) {
      return [errorFrame('E_NO_INTENTS', 'this hub was given no intent dispatch')]
    }
    const epoch = str(f, 'epoch')
    const raw = f.body ? (JSON.parse(new TextDecoder().decode(f.body)) as unknown) : {}
    const ctx = await options.intentContext(record.channel)
    const outcome = await options.intents.run(id, raw, ctx)
    const out: Frame[] = [ackFrame(outcome, epoch)]

    if (!outcome.ok) {
      // Nothing is refreshed and nothing is committed. The client discards the epoch it staged.
      return out
    }
    // The intent invalidated through its own declared-write guard, so the store is already
    // cold. Everyone holding one of those keys is told; the connection that ran the intent is
    // not, because it is about to be handed the new values instead of a note about old ones.
    if (outcome.dropped.length) {
      await hub.notify(outcome.dropped, `${outcome.name ?? outcome.id} invalidated it`, {
        except: record.channel.id,
      })
    }
    if (outcome.refresh.length) {
      out.push(
        ...(await refresh(
          record,
          frame('REFRESH', {
            s: outcome.refresh.join(','),
            ...(epoch ? { epoch, commit: 'true' } : {}),
          }),
        )),
      )
    }
    return out
  }

  /**
   * One REFRESH, any number of slots. `epoch` stages instead of sending, which is the whole
   * point of an epoch: the data arrives, resolves, and paints nothing. `commit` flips
   * everything staged under that epoch at once — set both on one frame and you have an
   * optimistic update, which is a staged epoch committed immediately.
   */
  async function refresh(record: ChannelRecord, f: AnyFrame): Promise<Frame[]> {
    if (!record.negotiation) {
      return [
        errorFrame('E_NO_NEGOTIATION', 'send RESIDENT before REFRESH: a form cannot be chosen without it'),
      ]
    }
    const epoch = str(f, 'epoch')
    const wants = list(f, 's')
    const slots = wants.length ? wants : [...record.held.keys()]
    const out: Frame[] = []

    for (const slot of slots) {
      const source = await options.source({ slot, channel: record.channel })
      if (!source) {
        out.push(errorFrame('E_NO_SUCH_SLOT', slot))
        continue
      }
      const held = record.held.get(slot)
      const result = await surgicalRefresh({
        slot,
        ir: source.ir,
        next: source.values,
        store: options.store,
        accepted: record.negotiation.forms,
        ...(held ? { held } : {}),
        ...(source.resolve ? { resolve: source.resolve } : {}),
        ...(source.prefer ? { prefer: source.prefer } : {}),
        ...(source.fallback ? { fallback: source.fallback } : {}),
        ...(record.hello?.rtt !== undefined ? { rttMs: record.hello.rtt } : {}),
        ...(options.ttl ? { ttl: options.ttl } : {}),
      })
      record.held.set(slot, { slot, tpl: source.ir.version, base: result.nextBase })
      if (source.key) stale.hold(record.channel.id, slot, source.key)
      options.telemetry?.measure('channel.refresh', result.memoized ? 0 : 1, {
        slot,
        form: result.choice.form,
        memoized: String(result.memoized),
      })
      if (epoch) record.epochs.stage(epoch, slot, result.frame)
      else out.push(result.frame)
    }

    if (epoch && str(f, 'commit') !== undefined) {
      const transition = (str(f, 'transition') ?? 'view') as Transition
      out.push(...record.epochs.commit(epoch, transition))
    }
    return out
  }

  return hub
}

/**
 * What this build can actually serve. The two wire packages are versioned independently and
 * neither can see the other's version, so this is the only place that can state both — and
 * stating it anywhere else is how a server ends up advertising an IR major it stopped
 * emitting three minors ago.
 */
export function serverCapabilities(overrides: Partial<ServerCapabilities> = {}): ServerCapabilities {
  return { warp: WARP_VERSION, ir: TEMPLATE_IR_VERSION, forms: [...WARP_FORMS], ...overrides }
}

export class ChannelError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(`${code} — ${message}`)
    this.name = 'ChannelError'
    this.code = code
  }
}

const utf8 = new TextEncoder()

export function errorFrame(code: string, detail: string): Frame {
  return frame('ERROR', { code, detail })
}

/**
 * The ACK. Carries the outcome rather than only the fact of arrival, because a client that
 * staged an optimistic epoch needs to know whether to commit it or throw it away — and
 * "discard this epoch" is that answer, not a frame of its own.
 *
 * Here rather than beside the dispatcher, so a channel takes `IntentDispatch` as a type and
 * never imports the intent module at runtime. An ACK is a frame; framing is this file's job.
 */
export function ackFrame(outcome: IntentOutcome, epoch?: string): Frame {
  return frame('ACK', {
    i: outcome.id,
    ok: outcome.ok,
    ...(epoch ? { epoch } : {}),
    ...(outcome.code ? { code: outcome.code } : {}),
    ...(outcome.detail ? { detail: outcome.detail } : {}),
    ...(outcome.invalidated.length ? { tags: outcome.invalidated.join(',') } : {}),
    ...(outcome.refresh.length ? { s: outcome.refresh.join(',') } : {}),
  })
}
