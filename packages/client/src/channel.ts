import type { Adopted } from './adopt.ts'
import { applyDelta, baseMatches, type DeltaPayload } from './delta.ts'
import type { Epochs } from './epoch.ts'
import type { ClientTemplate, Json } from './template.ts'

/**
 * The client half of the channel. A frame arrives, and it lands somewhere specific: a delta
 * becomes one DOM write per changed value, a COMMIT flips a staged epoch, a STALE is handed
 * to the application to decide about, and a TPL joins the resident set.
 *
 * The decision worth naming is that nothing here paints on arrival unless the frame says to.
 * A frame carrying an epoch is staged and invisible; only COMMIT paints. That is what makes
 * a background revalidation unable to disturb a half-typed form, and it is a property of
 * where the frames are routed rather than of anything the application remembers to do.
 *
 * Deliberately not a transport. This takes decoded frames and returns what it did with them,
 * so the same code path is exercised by a socket, by an SSE stream, and by a test — and the
 * ~700 bytes of socket plumbing is not paid for by a page that only reads.
 */
export type FrameKindText = string

export interface ChannelFrame {
  kind: FrameKindText
  header: Record<string, string | number | boolean>
  body?: Uint8Array
}

export interface Region {
  slot: string
  adopted: Adopted
  /** The base render this region is currently showing. A delta whose base disagrees is refused. */
  base: string
}

export interface ChannelClientOptions {
  epochs: Epochs
  /** Regions this client is holding, by slot name. */
  regions(): Region[]
  /** A template arrived. Returning is enough; persistence is the resident store's job. */
  onTemplate?(template: ClientTemplate): void | Promise<void>
  /** A region the server says is stale. The client decides: now, on focus, or never. */
  onStale?(slot: string, reason: string): void
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

export interface Acked {
  intent: string
  ok: boolean
  epoch?: string
  code?: string
  detail?: string
}

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
}

const decoder = new TextDecoder()
const encoder = new TextEncoder()

function text(frame: ChannelFrame, key: string): string | undefined {
  const value = frame.header[key]
  return value === undefined ? undefined : String(value)
}

export interface ChannelClient {
  apply(frames: readonly ChannelFrame[]): Promise<Applied>
  /**
   * The HELD header the server needs: what this client is showing, per slot.
   *
   * `only` says this is the whole of it, which is what a client that has navigated has to say —
   * slot names belong to a page, so without it the previous page's regions stay in the server's
   * map and are refreshed and invalidated as though somebody were still looking at them.
   */
  held(options?: { only?: boolean }): Record<string, string | boolean>
  /**
   * The INTENT frame to send, and — when `epoch` is given — the client's own guess staged into
   * that epoch first.
   *
   * The order matters and is the whole mechanism. The guess is staged, so it paints nothing and
   * the page is undisturbed. If the server agrees it stages the real values into the same epoch
   * and commits, and the guess is replaced by the truth in one paint. If it refuses, the ACK
   * says so and `apply` discards the epoch — nothing painted, so nothing has to be un-painted.
   *
   * Sending the frame is the application's: this module takes decoded frames and returns frames
   * to send, so the same code path serves a socket, an SSE stream with POSTs up, and a test.
   */
  intent(id: string, input: unknown, options?: OptimisticOptions): ChannelFrame
  /** Stage a locally-computed change without an intent. A guess with nothing to confirm it. */
  stage(epoch: string, slot: string, changed: Record<string, Json>): void
}

export interface OptimisticOptions {
  epoch?: string
  /** The client's guess, per slot: the values it expects the mutation to produce. */
  optimistic?: Record<string, Record<string, Json>>
}

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
      // Warp's `HELD_ONLY`, written out rather than imported: this package depends on nothing,
      // which is what lets a page carry the runtime without carrying the codec.
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
            // A delta is a function of two specific states. Applied against a third it would
            // write plausible values into the wrong render, so a base mismatch is refused
            // rather than best-efforted.
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
            options.onHtml?.(slot, frame.body ? decoder.decode(frame.body) : '', base)
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
            // The whole of the rollback. An optimistic update is a staged epoch, so undoing it
            // is discarding that epoch rather than reconstructing what was there before — and
            // nothing painted, so there is nothing to un-paint.
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
            break
        }
      }
      return result
    },
  }
}
