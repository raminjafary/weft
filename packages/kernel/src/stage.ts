import { frame, str, type Frame } from '@weftjs/warp'
import type { Channel, SlotFrames, SlotRender, WarmHandler } from './channel.ts'
import type { StorePort, TelemetryPort } from './ports.ts'
import { surgicalRefresh, type RefreshTtl } from './refresh.ts'

/**
 * A whole route, staged and painting nothing — `REFRESH` for a page the client is not on. The held
 * map is not touched; nothing is committed until the reader clicks. See `spec/client/navigation.md`.
 */
export interface StagedRoute {
  /** The pattern that matched, for a client that wants to name what it staged. */
  route: string
  /** Whether the target shares this connection's shell. Only the server can decide: only it knows both shells. */
  shared: boolean
  title?: string
  /** The stylesheet the target links, so a commit can put the cascade in place before it paints. */
  css?: string
  /** Routes worth staging from the target once it is committed. A profile's own numbers. */
  next?: readonly string[]
  /**
   * What each of the target's regions is: something to render here, or frames somebody else
   * produced — the same union a refresh already branches on. The stage adds the epoch.
   */
  slots?: Record<string, SlotRender | SlotFrames>
  /** Why the client is being sent to the document, when it is. */
  why?: string
}

/** A route asked for before anybody clicked, and the epoch it is being staged into. */
export interface StageRequest {
  path: string
  channel: Channel
  /** The epoch the client wants this staged into. Without one there is nowhere to put it. */
  epoch?: string
}

/** What the hub calls. A `WARM` carrying `at=` is one grain of one frame, and this answers it. */
export type RouteStager = WarmHandler

/** How to resolve a route, and how to tell whether it shares this client's document. */
export interface StageOptions {
  store: StorePort
  /** What the path resolves to, which is route knowledge a channel does not have. */
  resolve(request: StageRequest): Promise<StagedRoute | null> | StagedRoute | null
  ttl?: RefreshTtl
  telemetry?: TelemetryPort
}

/**
 * Answers `WARM at=`, which is a route staged and painted nowhere. Two decisions only this side can
 * make: whether the target shares the client's shell, and each region's next state.
 */
export function createStager(options: StageOptions): RouteStager {
  return async (asked) => {
    const epochAsked = str(asked.frame, 'epoch')
    const request: StageRequest = {
      path: asked.value,
      channel: asked.channel,
      ...(epochAsked ? { epoch: epochAsked } : {}),
    }
    const negotiation = request.channel.negotiation
    if (!negotiation) {
      return [error('E_NO_NEGOTIATION', 'send RESIDENT before WARM: a form cannot be chosen without it')]
    }
    const staged = await options.resolve(request)
    if (!staged) return [error('E_NO_SUCH_ROUTE', request.path)]

    const epoch = request.epoch
    if (!staged.shared || !staged.slots || !epoch) {
      // The epoch comes back on a refusal too: it is also the name the client gave this question,
      // and without it a `form=document` answer could not be matched to the route being staged —
      // the promise sat out the full grace period before falling back.
      return [
        frame('NAV', {
          at: request.path,
          route: staged.route,
          form: 'document',
          ...(epoch ? { epoch } : {}),
          why: staged.why ?? (epoch ? 'a different shell has different holes' : 'no epoch to stage into'),
        }),
      ]
    }

    const names = Object.keys(staged.slots)
    const out: Frame[] = [
      frame('NAV', {
        at: request.path,
        route: staged.route,
        form: 'slots',
        epoch,
        s: names.join(','),
        ...(staged.title ? { title: staged.title } : {}),
        ...(staged.css ? { css: staged.css } : {}),
        ...(staged.next?.length ? { next: staged.next.join(',') } : {}),
      }),
    ]

    for (const [slot, source] of Object.entries(staged.slots)) {
      // A region from another deployment, staged as it arrived: what paints carries the epoch,
      // what does not travels immediately.
      if (!('ir' in source)) {
        if (source.also) out.push(...source.also)
        if (source.paint) out.push({ ...source.paint, header: { ...source.paint.header, epoch } })
        options.telemetry?.measure('channel.stage', 1, { slot, form: 'region', at: request.path })
        continue
      }
      // The base this client holds for the same slot on the page it is on, usable only when the
      // template matches — `surgicalRefresh` checks that before diffing.
      const held = request.channel.held.get(slot)
      const result = await surgicalRefresh({
        slot,
        ir: source.ir,
        next: source.values,
        store: options.store,
        accepted: negotiation.forms,
        ...(held ? { held } : {}),
        ...(source.resolve ? { resolve: source.resolve } : {}),
        ...(source.prefer ? { prefer: source.prefer } : {}),
        ...(source.fallback ? { fallback: source.fallback } : {}),
        ...(request.channel.hello?.rtt !== undefined ? { rttMs: request.channel.hello.rtt } : {}),
        ...(options.ttl ? { ttl: options.ttl } : {}),
        // Nothing it chooses may be a form whose addresses another commit can move.
        staged: true,
      })
      options.telemetry?.measure('channel.stage', 1, {
        slot,
        form: result.choice.form,
        at: request.path,
      })
      out.push({ ...result.frame, header: { ...result.frame.header, epoch } })
    }
    return out
  }
}

function error(code: string, detail: string): Frame {
  return frame('ERROR', { code, detail })
}
