import type { Adopted } from './adopt.ts'
import { applyDelta, baseMatches, type DeltaPayload } from './delta.ts'
import type { Epochs } from './epoch.ts'
import type { StagedNav } from './navigate.ts'
import type { ClientTemplate, Json } from './template.ts'

/** The client half of the channel. See `spec/kernel/transport.md`: "Epochs, over the wire". */
export type FrameKindText = string

/** A frame as the client sees it: the kind, its header, and an already-decoded body. */
export interface ChannelFrame {
  kind: FrameKindText
  header: Record<string, string | number | boolean>
  body?: Uint8Array
}

/** One live region on this page: what it holds, and what it will accept next. */
export interface Region {
  slot: string
  adopted: Adopted
  /** The base render this region is currently showing. A delta whose base disagrees is refused. */
  base: string
}

/** What the runtime needs to route frames into regions: the regions, and where to apply them. */
export interface ChannelClientOptions {
  epochs: Epochs
  /** Regions this client is holding, by slot name. */
  regions(): Region[]
  /** A template arrived. Returning is enough; persistence is the resident store's job. */
  onTemplate?(template: ClientTemplate): void | Promise<void>
  /** A region the server says is stale. The client decides: now, on focus, or never. */
  onStale?(slot: string, reason: string): void
  /** A frame this build does not route. The extension point a capability that owns a frame kind uses. See `spec/kernel/budgets.md`. */
  onFrame?(frame: ChannelFrame, applied: Applied): void
  /** Markup for a slot the server could not send a delta for. */
  onHtml?(slot: string, html: string, base: string): void
  onError?(code: string, detail: string): void
  /** An intent came back. Called for both outcomes, because a failure is news too. */
  onAck?(ack: Acked): void
  onRedirect?(to: string, replace: boolean): void
  onCookie?(name: string, value: string): void
  /** What the client tells the server it holds. Rebuilt on demand, never cached stale. */
  onCommit?(epoch: string, slots: string[]): void
}

/** The outcome of an intent this client sent, and whether its epoch survives. */
export interface Acked {
  intent: string
  ok: boolean
  epoch?: string
  code?: string
  detail?: string
}

/** What an arriving frame did to the page — which region, which form, how long. */
export interface Applied {
  /** DOM writes actually performed. A staged frame performs none, which is the point. */
  writes: number
  staged: string[]
  committed: string[]
  stale: string[]
  templates: string[]
  refused: { slot: string; reason: string }[]
  errors: { code: string; detail: string }[]
  /** Intent outcomes. A failed one names the epoch that was discarded because of it. */
  acked: Acked[]
  discarded: string[]
  /**
   * Routes the server answered a stage for, refused or otherwise. Filled by `navFrames`, which is
   * navigation's handler rather than this file's — see `onFrame`.
   */
  navs: StagedNav[]
}

const decoder = new TextDecoder()
const encoder = new TextEncoder()

function text(frame: ChannelFrame, key: string): string | undefined {
  const value = frame.header[key]
  return value === undefined ? undefined : String(value)
}

/** The client half of the protocol, and deliberately not a transport. Opening a connection is the front door's job. */
export interface ChannelClient {
  apply(frames: readonly ChannelFrame[]): Promise<Applied>
  /** The HELD header the server needs: what this client is showing, per slot. See `spec/warp/warp-1.md`: HELD, `$only`. */
  held(options?: { only?: boolean }): Record<string, string | boolean>
  /** The INTENT frame to send, and — when `epoch` is given — the client's own guess staged into that epoch first. See `spec/kernel/transport.md`. */
  intent(id: string, input: unknown, options?: OptimisticOptions): ChannelFrame
  /** Stage a locally-computed change without an intent. A guess with nothing to confirm it. */
  stage(epoch: string, slot: string, changed: Record<string, Json>): void
}

/** What to stage while an intent is in flight, and under which epoch. */
export interface OptimisticOptions {
  epoch?: string
  /** The client's guess, per slot: the values it expects the mutation to produce. */
  optimistic?: Record<string, Record<string, Json>>
}

/** A client over a set of regions. Frames in, applied updates out. */
export function createChannelClient(options: ChannelClientOptions): ChannelClient {
  const byName = (): Map<string, Region> => new Map(options.regions().map((r) => [r.slot, r]))

  return {
    stage(epoch, slot, changed) {
      const region = byName().get(slot)
      if (!region) return
      options.epochs.stage(epoch, {
        slot,
        adopted: region.adopted,
        delta: { tpl: region.adopted.template.version, base: region.base, changed },
      })
    },

    intent(id, input, opts = {}) {
      const epoch = opts.epoch
      if (epoch && opts.optimistic) {
        for (const [slot, changed] of Object.entries(opts.optimistic)) {
          this.stage(epoch, slot, changed)
        }
      }
      return {
        kind: 'INTENT',
        header: { i: id, ...(epoch ? { epoch } : {}) },
        body: encoder.encode(JSON.stringify(input)),
      }
    },

    held(opts = {}) {
      const out: Record<string, string | boolean> = {}
      for (const region of options.regions()) {
        out[region.slot] = `${region.adopted.template.version}-${region.base}`
      }
      // Warp's `HELD_ONLY`, written out rather than imported: this package has no dependencies.
      if (opts.only) out.$only = true
      return out
    },

    async apply(frames) {
      const result: Applied = {
        writes: 0,
        staged: [],
        committed: [],
        stale: [],
        templates: [],
        refused: [],
        errors: [],
        acked: [],
        discarded: [],
        navs: [],
      }
      const regions = byName()

      for (const frame of frames) {
        switch (frame.kind) {
          case 'DELTA': {
            const slot = text(frame, 's') ?? ''
            const region = regions.get(slot)
            if (!region) {
              result.refused.push({ slot, reason: 'no such region on this client' })
              break
            }
            const delta: DeltaPayload = {
              tpl: text(frame, 'tpl') ?? region.adopted.template.version,
              base: text(frame, 'base') ?? '',
              changed: (frame.body ? JSON.parse(decoder.decode(frame.body)) : {}) as Record<string, Json>,
            }
            // See `spec/kernel/transport.md`: "What the client refuses".
            if (!baseMatches(region.base, delta)) {
              result.refused.push({ slot, reason: `holds ${region.base}, delta is from ${delta.base}` })
              break
            }
            const epoch = text(frame, 'epoch')
            const next = text(frame, 'next') ?? region.base
            if (epoch) {
              options.epochs.stage(epoch, { slot, adopted: region.adopted, delta })
              result.staged.push(slot)
              break
            }
            result.writes += applyDelta(region.adopted, delta)
            region.base = next
            break
          }

          case 'HTML': {
            const slot = text(frame, 's') ?? ''
            const base = text(frame, 'base') ?? ''
            const html = frame.body ? decoder.decode(frame.body) : ''
            const epoch = text(frame, 'epoch')
            // Without an epoch, this paints now. With one, it's staged like the deltas. See `spec/kernel/transport.md`.
            if (epoch) {
              const region_ = regions.get(slot)
              options.epochs.stage(epoch, {
                slot,
                html,
                base,
                paint: (painted, showing) => {
                  options.onHtml?.(slot, painted, showing)
                  if (region_) region_.base = showing
                },
              })
              result.staged.push(slot)
              break
            }
            options.onHtml?.(slot, html, base)
            const region = regions.get(slot)
            if (region) region.base = base
            break
          }

          case 'COMMIT': {
            const epoch = text(frame, 'epoch') ?? ''
            const transition = text(frame, 'transition') === 'view'
            const committed = await options.epochs.commit(epoch, { transition })
            result.writes += committed.writes
            result.committed.push(epoch)
            // The bases the staged deltas moved to are only true once they are painted.
            for (const slot of committed.slots) {
              const region = regions.get(slot)
              const next = frames.find((f) => f.kind === 'DELTA' && text(f, 's') === slot)
              if (region && next) region.base = text(next, 'next') ?? region.base
            }
            options.onCommit?.(epoch, committed.slots)
            break
          }

          case 'ACK': {
            const ack: Acked = {
              intent: text(frame, 'i') ?? '',
              ok: text(frame, 'ok') === 'true',
              ...(text(frame, 'epoch') ? { epoch: text(frame, 'epoch') as string } : {}),
              ...(text(frame, 'code') ? { code: text(frame, 'code') as string } : {}),
              ...(text(frame, 'detail') ? { detail: text(frame, 'detail') as string } : {}),
            }
            result.acked.push(ack)
            // The whole of the rollback: discard the epoch. See `spec/kernel/transport.md`.
            if (!ack.ok && ack.epoch) {
              options.epochs.discard(ack.epoch)
              result.discarded.push(ack.epoch)
            }
            options.onAck?.(ack)
            break
          }

          case 'STALE': {
            const slot = text(frame, 's') ?? ''
            result.stale.push(slot)
            options.onStale?.(slot, text(frame, 'reason') ?? 'stale')
            break
          }

          case 'TPL': {
            if (!frame.body) break
            const template = JSON.parse(decoder.decode(frame.body)) as ClientTemplate
            result.templates.push(template.version)
            await options.onTemplate?.(template)
            break
          }

          case 'REDIRECT':
            options.onRedirect?.(text(frame, 'to') ?? '/', text(frame, 'replace') === 'true')
            break

          case 'COOKIE':
            options.onCookie?.(text(frame, 'name') ?? '', text(frame, 'value') ?? '')
            break

          case 'ERROR':
            result.errors.push({
              code: text(frame, 'code') ?? 'E_UNKNOWN',
              detail: text(frame, 'detail') ?? '',
            })
            options.onError?.(text(frame, 'code') ?? 'E_UNKNOWN', text(frame, 'detail') ?? '')
            break

          default:
            options.onFrame?.(frame, result)
            break
        }
      }
      return result
    },
  }
}
