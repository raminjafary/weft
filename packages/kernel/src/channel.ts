import {
  clientView,
  TEMPLATE_IR_VERSION,
  type Resolver,
  type TemplateIR,
  type Values,
  type WireForm,
} from '@weftjs/ir'
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
} from '@weftjs/warp'
import { createEpochs, type Epochs, type Transition } from './epoch.ts'

import type { EnvelopeContext } from './context.ts'
import type { IntentDispatch, IntentOutcome } from './intent.ts'
import type { StorePort, TelemetryPort } from './ports.ts'
import {
  createStaleRegistry,
  parseHeld,
  surgicalRefresh,
  type PatchEncoder,
  type Held,
  type RefreshTtl,
  type StaleRegistry,
} from './refresh.ts'

/**
 * The channel: one client, one Warp frame stream, and none of the four bindings. Binding-agnostic
 * on purpose — a streamed response, SSE and a WebSocket are `ChannelSink` implementations and one
 * state machine here; `turn` is the fourth, the one that is not a connection. See `spec/kernel/transport.md`.
 */
export type ChannelBinding = 'stream' | 'sse' | 'socket' | 'turn'

/**
 * The transport underneath a channel, whichever of the four bindings it is. `saturated` is the
 * field that matters — a sink that never reports it makes a slow consumer look like a fast one.
 */
export interface ChannelSink {
  readonly binding: ChannelBinding
  /** False once the peer has gone. Sending to a closed sink is dropped and reported, never thrown. */
  readonly open: boolean
  /** True when the transport's buffer is above its watermark. See `spec/kernel/transport.md`. */
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

/** A region asked for over the channel, with the epoch it is being staged into. */
export interface SlotRequest {
  slot: string
  channel: Channel
  /**
   * The frame that asked, for a source that needs another header off it: a bare `REFRESH` asks for
   * current state, one carrying `r=<id>` asks to put a catalogue entry in the slot.
   */
  frame?: Frame
}

/**
 * A slot this channel does not render: frames somebody else produced, ready to go down the wire —
 * a second shape of `SlotSource` answer rather than a second option, to keep the byte budget in one
 * place. `paint` is what an epoch stages; `also` travels immediately. See `spec/kernel/budgets.md`.
 */
export interface SlotFrames {
  paint?: Frame
  also?: readonly Frame[]
}

/** How the hub reaches a region's renderer. The channel has no request, so this is supplied. */
export type SlotSource = (
  request: SlotRequest,
) => Promise<SlotRender | SlotFrames | null> | SlotRender | SlotFrames | null

/** What a `WARM` asked about at one grain, and everything a handler needs to answer it. */
export interface WarmRequest {
  /** The grain's value: a path for `at`, a plan prefix for `plan`. */
  value: string
  /** The frame itself, for a handler that needs another header off it — `epoch`, say. */
  frame: Frame
  channel: Channel
}

/** What answers a `WARM` grain the hub does not handle itself. Templates are the one it does. */
export type WarmHandler = (request: WarmRequest) => Promise<Frame[]>

/** One connection's state: what it negotiated, what it holds, and where it last committed. */
export interface Channel {
  readonly id: string
  readonly binding: ChannelBinding
  /** Null until RESIDENT arrives. Every form decision needs it. */
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

/** What a hub needs, and what each absent capability refuses by name rather than dropping. */
export interface HubOptions {
  store: StorePort
  source: SlotSource
  /** What answers an INTENT frame. Optional — its absence is `E_NO_INTENTS` rather than a silent drop. */
  intents?: IntentDispatch
  /** The envelope context an intent runs against. A channel has no request, so the caller supplies one. */
  intentContext?(channel: Channel): EnvelopeContext | Promise<EnvelopeContext>
  /** Templates a WARM frame may ask for. Without one, WARM is refused by name. */
  templates?: (version: string) => TemplateIR | undefined
  /**
   * Who answers a `WARM` at each grain, by the header that names the grain. A table rather than one
   * option per grain, so a deployment that binds none carries none of it. See `spec/kernel/budgets.md`.
   */
  warm?: Record<string, WarmHandler>
  /**
   * Everyone this process cannot reach, told after the ones it can. One hook rather than the two
   * ports the caller may bind, so a hub that named them would carry a branch per capability. See
   * `spec/kernel/transport.md`.
   */
  onInvalidated?(keys: readonly string[], reason: string): Promise<void> | void
  /**
   * Frames appended to the handshake answer, after `WARP` — the one thing a client cannot ask for,
   * because it does not know what it is missing. `createExtender` in `discover.ts` fills it.
   */
  onOpen?(channel: Channel): Promise<readonly Frame[]> | readonly Frame[]
  /**
   * The invalidation key a slot this client is *showing* would be held under, without rendering it.
   * Cannot be derived here — the key is a property of the route, which the front door knows and the
   * hub does not. See `spec/kernel/transport.md`.
   */
  keyFor?(slot: string, channel: Channel): Promise<string | undefined> | string | undefined
  server?: ServerCapabilities
  maxEpochs?: number
  /** Consecutive saturated sends before a channel is closed as a slow consumer. See `spec/kernel/transport.md`. */
  maxSaturatedSends?: number
  /** How long recovered base renders and memoized deltas live. Expiry costs a form, never correctness. */
  ttl?: RefreshTtl
  /**
   * The patch encoder, the second rung on the surgical ladder. Optional and measured that way:
   * `patchPayload` cost every entry on the refresh path ~440 B. See `spec/kernel/surgical.md`.
   */
  patch?: PatchEncoder
  telemetry?: TelemetryPort
}

/** Every open channel, and the frames that pass through them. */
export interface ChannelHub {
  /** Open a channel, or rebind an existing one under the same id: a frozen webview reconnects and
   * keeps the base renders it was known to hold. */
  open(sink: ChannelSink, id: string): Channel
  get(id: string): Channel | undefined
  /** Frames from a client, whatever binding carried them. Returns what went back down. */
  receive(id: string, frames: readonly AnyFrame[]): Promise<Frame[]>
  /** Invalidate tags, then tell every open channel holding one of the dropped keys. The client
   * decides whether and when to refresh. */
  invalidate(tags: string[], reason?: string): Promise<{ keys: string[]; notified: number }>
  /** Tell connections about keys something else already dropped — the store is already cold by
   * the time the channel sees the outcome. */
  notify(keys: readonly string[], reason: string, options?: { except?: string }): Promise<number>
  /**
   * Tell every connection showing one of these slots that it is stale, by slot rather than by key —
   * the path an invalidation takes across a tier boundary, where this composite holds no keys of
   * the region's own. See `spec/kernel/composition.md`.
   */
  notifySlots(slots: readonly string[], reason: string, options?: { except?: string }): Promise<number>
  close(id: string, reason?: string): void
  readonly channels: number
  readonly stale: StaleRegistry
}

/** A hub over the ports and handlers a deployment bound. */
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
      // Published after the local notify, and its failure does not undo it: a broker being down
      // must not turn a partial success into an exception.
      try {
        await options.onInvalidated?.(keys, reason)
      } catch (error) {
        options.telemetry?.measure('channel.elsewhere.failed', 1, { detail: String(error) })
      }
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

    notifySlots,
  }

  async function handle(record: ChannelRecord, f: AnyFrame): Promise<Frame[]> {
    // A negotiation that failed is the end of the stream, not a caveat on it: everything after it
    // used to be answered normally, which handed frames to a client already told the stream is
    // unusable.
    if (record.negotiation && !record.negotiation.ok && f.kind !== 'RESIDENT') {
      return [errorFrame('E_WARP_MAJOR', record.negotiation.fatal ?? 'this stream was refused')]
    }
    switch (f.kind) {
      case 'RESIDENT': {
        record.hello = readResident(f as Frame)
        record.negotiation = negotiate(record.hello, options.server ?? serverCapabilities())
        // The negotiation, and then what this client does not know about the plan — unasked, exactly
        // once per connection, because the client has no route table to notice a gap in.
        return [warpFrame(record.negotiation), ...((await options.onOpen?.(record.channel)) ?? [])]
      }

      case 'HELD': {
        // A client that says this is everything it holds has gone somewhere else, and slot names
        // belong to a page: both the held map and the stale registry are dropped before the new
        // set is read.
        if (bool(f, HELD_ONLY)) {
          record.held.clear()
          stale.release(record.channel.id)
        }
        for (const h of parseHeld(f as Frame)) record.held.set(h.slot, h)
        // And recorded as holding it, so an invalidation can find this connection. See
        // `spec/kernel/transport.md`. Done after the loop: `only: true` clears the registry above.
        for (const slot of record.held.keys()) {
          const key = await options.keyFor?.(slot, record.channel)
          if (key) stale.hold(record.channel.id, slot, key)
        }
        return []
      }

      case 'RESUME': {
        record.resumedAt = str(f, 'epoch') ?? null
        // Nothing is replayed: the client named what it holds and the held map survived the
        // rebind, so the next REFRESH produces a delta rather than a first render.
        return record.negotiation ? [warpFrame(record.negotiation)] : []
      }

      case 'WARM': {
        // One question at whichever grain the frame names. A `WARM` carrying two is answered at the
        // first: it asked two questions in a frame that means one.
        for (const grain in options.warm) {
          const value = str(f, grain)
          if (value === undefined) continue
          return (options.warm[grain] as WarmHandler)({ value, frame: f as Frame, channel: record.channel })
        }
        // `tpl` is the one grain a channel can answer on its own; anything else with no handler is
        // named rather than dropped.
        if (str(f, 'tpl') === undefined) {
          return [
            errorFrame(
              'E_NO_WARM_HANDLER',
              `nothing is registered to stage ${Object.keys(f.header).join(',') || 'this grain'}`,
            ),
          ]
        }
        if (!options.templates) {
          return [errorFrame('E_NO_TEMPLATE_REGISTRY', 'this hub was given no template registry')]
        }
        const out: Frame[] = []
        for (const version of list(f, 'tpl')) {
          const ir = options.templates(version)
          if (!ir) {
            out.push(errorFrame('E_NO_SUCH_TEMPLATE', `no sealed template has version ${version}`))
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
   * One INTENT: dispatch it, tell the client what happened, and refresh what the mutation says it
   * changed. The epoch is why this is worth doing over a channel: rollback needs no frame of its
   * own, because the client just discards it. See `spec/kernel/surgical.md`.
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
    // `t` is the signature, in the header rather than the body: the body is the payload a bound
    // token is checked against, and a token inside what it signs cannot be verified.
    const token = str(f, 't')
    const outcome = await options.intents.run(id, raw, ctx, token ? { token } : {})
    const out: Frame[] = [ackFrame(outcome, epoch)]

    if (!outcome.ok) {
      // Nothing is refreshed and nothing is committed. The client discards the epoch it staged.
      return out
    }
    // Everyone holding a dropped key is told; the connection that ran the intent is not, since
    // it is about to be handed the new values instead of a note about old ones.
    if (outcome.dropped.length) {
      await hub.notify(outcome.dropped, `${outcome.name ?? outcome.id} invalidated it`, {
        except: record.channel.id,
      })
    }
    /**
     * What this connection is refreshed for: what the intent named, and what it is holding that the
     * write dropped. See `spec/kernel/transport.md`.
     */
    const held = stale.holding(record.channel.id, outcome.dropped)
    const refreshing = [...new Set([...outcome.refresh, ...held])]
    if (refreshing.length) {
      out.push(
        ...(await refresh(
          record,
          frame('REFRESH', {
            s: refreshing.join(','),
            ...(epoch ? { epoch, commit: 'true' } : {}),
          }),
        )),
      )
    }
    return out
  }

  /**
   * One slot, rendered into the smallest form this client can apply. Shared by a refresh and by a
   * route being staged — the only difference is whether the answer becomes what the server
   * believes the client is showing.
   */
  async function serveSlot(
    record: ChannelRecord,
    slot: string,
    source: SlotRender | SlotFrames,
    remember: boolean,
    staged = false,
  ): Promise<SlotFrames & { frame?: Frame }> {
    // Frames from elsewhere are already the smallest form their producer could send.
    if (!('ir' in source)) return source
    const held = record.held.get(slot)
    const result = await surgicalRefresh({
      slot,
      ir: source.ir,
      next: source.values,
      store: options.store,
      accepted: (record.negotiation as Negotiation).forms,
      ...(held ? { held } : {}),
      ...(source.resolve ? { resolve: source.resolve } : {}),
      ...(source.prefer ? { prefer: source.prefer } : {}),
      ...(source.fallback ? { fallback: source.fallback } : {}),
      ...(record.hello?.rtt !== undefined ? { rttMs: record.hello.rtt } : {}),
      ...(options.ttl ? { ttl: options.ttl } : {}),
      ...(staged ? { staged } : {}),
      ...(options.patch ? { patch: options.patch } : {}),
    })
    if (remember) {
      record.held.set(slot, { slot, tpl: source.ir.version, base: result.nextBase })
      if (source.key) stale.hold(record.channel.id, slot, source.key)
    }
    options.telemetry?.measure('channel.refresh', result.memoized ? 0 : 1, {
      slot,
      form: result.choice.form,
      memoized: String(result.memoized),
    })
    return result
  }

  /**
   * A slot's worth of invalidation, told to whoever is showing that slot. `record.held` is the only
   * thing that decides whether an invalidation is any of a connection's business.
   */
  async function notifySlots(
    slots: readonly string[],
    reason: string,
    only: { except?: string } = {},
  ): Promise<number> {
    const wanted = new Set(slots)
    let told = 0
    for (const [id, record] of live) {
      if (only.except === id) continue
      const frames = [...record.held.keys()]
        .filter((slot) => wanted.has(slot))
        .map((slot) => frame('STALE', { s: slot, reason }))
      if (!frames.length) continue
      told += await record.channel.send(frames)
    }
    return told
  }

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
      const source = await options.source({ slot, channel: record.channel, frame: f as Frame })
      if (!source) {
        out.push(errorFrame('E_NO_SUCH_SLOT', slot))
        continue
      }
      // An epoch means the frame is held rather than painted: a patch addresses nodes by position.
      const result = await serveSlot(record, slot, source, true, Boolean(epoch))
      const paint = result.frame ?? result.paint
      out.push(...(result.also ?? []))
      if (!paint) continue
      if (epoch) record.epochs.stage(epoch, slot, paint)
      else out.push(paint)
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
 * What this build can actually serve. The two wire packages are versioned independently, so this
 * is the only place that can state both.
 */
export function serverCapabilities(overrides: Partial<ServerCapabilities> = {}): ServerCapabilities {
  return { warp: WARP_VERSION, ir: TEMPLATE_IR_VERSION, forms: [...WARP_FORMS], ...overrides }
}

/** A channel refusal, carrying the code — which is also what goes into an ERROR frame. */
export class ChannelError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(`${code} — ${message}`)
    this.name = 'ChannelError'
    this.code = code
  }
}

const utf8 = new TextEncoder()

/** A refusal as a frame. A stage that silently did nothing is indistinguishable from one that worked. */
export function errorFrame(code: string, detail: string): Frame {
  return frame('ERROR', { code, detail })
}

/**
 * The ACK. Carries the outcome rather than only the fact of arrival: a client that staged an
 * optimistic epoch needs to know whether to commit it or discard it.
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
