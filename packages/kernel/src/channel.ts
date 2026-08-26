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
  type PatchEncoder,
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
  /**
   * The frame that asked, for a source that needs another header off it.
   *
   * The same field `WarmRequest` carries and for the same reason: a `REFRESH` asks *give me this
   * slot's current state*, and a `REFRESH` carrying `r=<id>` asks *put this catalogue entry in this
   * slot*. Both are answered by a slot source, and only the header tells them apart — so the header
   * has to reach it. A table of handlers keyed by frame shape would be a second dispatch mechanism in
   * this file, which is the thing its byte ceiling exists to prevent.
   */
  frame?: Frame
}

/**
 * A slot this channel does not render: frames somebody else produced, ready to go down the wire.
 *
 * It is a second shape of `SlotSource` answer rather than a second option on the hub, and that is
 * the byte budget deciding an interface again. A table of handlers keyed by slot would be a third
 * dispatch mechanism in a file with 29 bytes of headroom; a union on a return type that is already
 * being branched on is a few. What produces these frames — the composer, for a region on another
 * deployment — is charged to its own entry, and a channel that serves no region carries none of it.
 *
 * `paint` is the one frame that changes what the reader sees, so it is the one an epoch stages.
 * Everything in `also` is what a client needs in order to apply it — a template it does not hold, a
 * stylesheet, a module — and none of that paints, so it travels immediately even inside an epoch.
 * A region deciding that split itself is right: only the side that produced the frames knows which
 * of them is the picture.
 */
export interface SlotFrames {
  paint?: Frame
  also?: readonly Frame[]
}

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

export type WarmHandler = (request: WarmRequest) => Promise<Frame[]>

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
  /**
   * Who answers a `WARM` at each grain, by the header that names the grain.
   *
   * `WARM` asks one question — "stage this, do not paint" — about a template set (`tpl`), a route
   * (`at`), or a subtree of the plan (`plan`), and only the first of those is something a channel
   * can answer on its own. The rest are hooks, and they are a **table** rather than one option per
   * grain for a reason the byte budget made concrete twice.
   *
   * Route staging arrived as a branch here and took the transport entry 108 bytes past a watermark
   * set before it existed. Lazy plan extension arrived as a second branch and took it to five bytes
   * of headroom — a rule that says a new capability does not spend an existing entry's room, being
   * satisfied by five bytes, is a rule about to stop being satisfied. So the channel stopped
   * growing a case per capability: one lookup answers every grain, each handler is measured under
   * the entry that provides it, and a deployment that binds none of them carries none of them.
   *
   * `createStager` in `stage.ts` answers `at`; `createExtender` in `discover.ts` answers `plan`.
   */
  warm?: Record<string, WarmHandler>
  /**
   * Frames appended to the handshake answer, after `WARP`.
   *
   * Everything else here answers a question the client asked. This is the one thing a client cannot
   * ask for, because it does not know what it is missing: a page has no route table to notice a gap
   * in, and what is worth telling it — where readers of this page go next — is a measurement only
   * the server has. `createExtender` in `discover.ts` is what fills it.
   */
  onOpen?(channel: Channel): Promise<readonly Frame[]> | readonly Frame[]
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
  /**
   * The patch encoder, which is what puts the second rung on the surgical ladder: a region whose
   * values are not projectable updates node by node instead of being replaced whole.
   *
   * Optional because it is measured that way — `patchPayload` written into the refresh path cost
   * every entry carrying that path ~440 B of brotli, including two a deployment composing regions
   * pays and never uses. Bind it from `entry-patch.ts` and the rung is there; leave it and
   * `selectForm` says the rung is missing rather than falling silently to markup.
   */
  patch?: PatchEncoder
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
  /**
   * Tell every connection showing one of these slots that it is stale, by slot rather than by key.
   *
   * The path an invalidation takes when it crosses a tier boundary. `notify` above works from the
   * keys a store dropped, which is right for everything this deployment rendered and impossible for
   * anything it did not: a region holds its own keys and this composite holds a contract. What the
   * composite does hold is the answer to "which of my connections is showing that region", and this
   * is that answer turned into frames.
   *
   * It is deliberately not `invalidate`. Nothing is dropped from any store here, because there is
   * nothing of the region's in this deployment's store to drop — the region's markup came down a
   * wire. The client is told, and the client decides.
   */
  notifySlots(slots: readonly string[], reason: string, options?: { except?: string }): Promise<number>
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

    notifySlots,
  }

  async function handle(record: ChannelRecord, f: AnyFrame): Promise<Frame[]> {
    /**
     * A negotiation that failed is the end of the stream, not a caveat on it.
     *
     * `negotiate` can return `ok: false` — a major this server does not speak — and until now the
     * only consequence was a `WARP` frame that looked degraded. Everything after it was answered
     * normally, which is the worst of both: the client has been told the stream is unusable and is
     * then handed frames that depend on it. One refusal, by the name the negotiation gave.
     */
    if (record.negotiation && !record.negotiation.ok && f.kind !== 'RESIDENT') {
      return [errorFrame('E_WARP_MAJOR', record.negotiation.fatal ?? 'this stream was refused')]
    }
    switch (f.kind) {
      case 'RESIDENT': {
        record.hello = readResident(f as Frame)
        record.negotiation = negotiate(record.hello, options.server ?? serverCapabilities())
        /**
         * The negotiation, and then what this client does not know about the plan.
         *
         * Unasked, and exactly once per connection. Every other frame here answers a question the
         * client posed; this one exists because the client cannot pose it — it has no route table
         * to notice a gap in, and the thing worth telling it (where readers of this page go next)
         * is a measurement only the server has.
         */
        return [warpFrame(record.negotiation), ...((await options.onOpen?.(record.channel)) ?? [])]
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
        /**
         * One question at whichever grain the frame names, and the grains it does not name are not
         * this file's business. A `WARM` carrying two of them is answered at the first, because it
         * asked two questions in a frame that means one.
         */
        for (const grain in options.warm) {
          const value = str(f, grain)
          if (value === undefined) continue
          return (options.warm[grain] as WarmHandler)({ value, frame: f as Frame, channel: record.channel })
        }
        // `tpl` is the one grain a channel can answer on its own; anything else with no handler is
        // named rather than dropped, because a stage that silently does nothing is indistinguishable
        // from one that worked.
        if (str(f, 'tpl') === undefined) {
          return [errorFrame('E_NO_WARM_HANDLER', Object.keys(f.header).join(','))]
        }
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
    // `t` is the signature, in the header rather than the body: the body is the payload a bound
    // token is checked against, and a token inside what it signs cannot be verified.
    const token = str(f, 't')
    const outcome = await options.intents.run(id, raw, ctx, token ? { token } : {})
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
   * One slot, rendered into the smallest form this client can apply.
   *
   * Shared by a refresh and by a route being staged, because it is the same question both times:
   * what does this client hold, and what is the least that has to travel given that. The only
   * difference is whether the answer becomes what the server believes the client is showing —
   * true for a refresh of the page they are on, false for a route they have not gone to.
   */
  async function serveSlot(
    record: ChannelRecord,
    slot: string,
    source: SlotRender | SlotFrames,
    remember: boolean,
    staged = false,
  ): Promise<SlotFrames & { frame?: Frame }> {
    // Frames from elsewhere are already the smallest form their producer could send: it was given
    // what this client holds and made the choice on its own side. Choosing again here would mean
    // re-deriving a delta against a template this process does not have.
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
   * One REFRESH, any number of slots. `epoch` stages instead of sending, which is the whole
   * point of an epoch: the data arrives, resolves, and paints nothing. `commit` flips
   * everything staged under that epoch at once — set both on one frame and you have an
   * optimistic update, which is a staged epoch committed immediately.
   */
  /**
   * A slot's worth of invalidation, told to whoever is showing that slot.
   *
   * `record.held` is what this connection says it is displaying, which is the only thing that
   * decides whether an invalidation is any of its business. A connection showing none of these
   * slots is not told, and a connection showing two is told twice — once per slot, because a
   * client's decision about a stale region is per region.
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
      // An epoch means the frame is held rather than painted, which is the one fact a form
      // choice has to know beyond what the client holds: a patch addresses nodes by position.
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
