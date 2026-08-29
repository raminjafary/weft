import { frame, type Frame } from '@weftjs/warp'
import type { Channel, SlotFrames } from './channel.ts'
import type { Composer, RegionRequest, RegionSpec } from './region.ts'

/**
 * A region refreshed over a live channel: the same region, a different question. The region is
 * given what this client holds and makes the form choice on its own side. This module is the
 * adapter between what a composer returns and what a channel needs. See `spec/kernel/composition.md`.
 */
export interface ChannelRegionOptions {
  composer: Composer
  /** What the shell declares about each region it composes, by name. */
  regions: Record<string, RegionSpec>
  /** The route this channel is on, for a region that renders per route. */
  route?(channel: Channel): string | undefined
}

/** How a channel reaches a region's renderer, which may be on another deployment. */
export type ChannelRegions = (asked: {
  slot: string
  channel: Channel
  /**
   * Anything the caller knows that a channel does not — the same composition with a different
   * request, whether it is a refresh of this route or a different one being staged.
   */
  request?: RegionRequest
}) => Promise<SlotFrames | null>

/**
 * Answers a `REFRESH` for a region, or nothing when the slot is not one — which is what lets a
 * deployment chain this in front of its own slot source without either of them knowing about the
 * other.
 */
export function channelRegions(options: ChannelRegionOptions): ChannelRegions {
  return async ({ slot, channel, request: asked }) => {
    const spec = options.regions[slot]
    if (!spec) return null

    // What this client holds for the region, so it can answer with a delta rather than markup —
    // the same `held` map a local refresh consults.
    const held = channel.held.get(slot)
    const request: RegionRequest = {
      ...(options.route?.(channel) ? { route: options.route(channel) as string } : {}),
      ...(held ? { held: [held.tpl] } : {}),
      ...asked,
    }

    const outcome = await options.composer.compose(spec, request)
    const also = outcome.frames.filter((f) => !PAINTS.has(f.kind))
    const painted = outcome.frames.find((f) => PAINTS.has(f.kind))

    // Markup or a degraded fallback: either way the bytes travel as an `HTML` frame, exactly as
    // a local render's would.
    const paint =
      painted ?? (outcome.bytes.length ? frame('HTML', { s: slot }, outcome.bytes, true) : undefined)

    return {
      ...(paint ? { paint } : {}),
      ...(also.length ? { also } : {}),
    }
  }
}

/** Which kinds change what the reader sees. Everything else travels immediately even inside an epoch. */
const PAINTS = new Set<Frame['kind']>(['HTML', 'DELTA', 'DATA', 'PATCH'])
