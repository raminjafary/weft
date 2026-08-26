import { frame, type Frame } from '@weft/warp'
import type { Channel, SlotFrames } from './channel.ts'
import type { Composer, RegionRequest, RegionSpec } from './region.ts'

/**
 * A region refreshed over a live channel, which is the same region and a different question.
 *
 * In the document path a region's markup fills a hole in a shell being streamed. Over a channel
 * there is no shell: the page is already there, and what travels is the least that has to. That
 * turns out to need nothing new from the composite — the region is given what this client holds and
 * makes the choice on its own side, because it is the only side with the template. A `DELTA` for a
 * region whose template the client has comes back as a delta; a region it has never seen comes back
 * as markup.
 *
 * So this module is small on purpose. It is the adapter between what a composer returns and what a
 * channel needs: which frame paints — the one an epoch stages — and which frames are the things a
 * client needs in order to apply it.
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
   * Anything the caller knows that a channel does not.
   *
   * A refresh knows the route this connection is on and the reads the region's contract declared; a
   * route being staged knows a *different* route, its params, and the epoch the answer is being
   * staged into. Both are the same composition with a different request, which is why this is one
   * field rather than two functions — a second one would be a second place for a budget or a
   * contract to be applied slightly differently.
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

    // What this client holds for the region, so the region can answer with a delta rather than
    // markup. It is the same `held` map a local refresh consults, and handing it over is the whole
    // reason a remote region can participate in the surgical ladder at all.
    const held = channel.held.get(slot)
    const request: RegionRequest = {
      ...(options.route?.(channel) ? { route: options.route(channel) as string } : {}),
      ...(held ? { held: [held.tpl] } : {}),
      ...asked,
    }

    const outcome = await options.composer.compose(spec, request)
    const also = outcome.frames.filter((f) => !PAINTS.has(f.kind))
    const painted = outcome.frames.find((f) => PAINTS.has(f.kind))

    // A region that answered with markup rather than a delta, or degraded to its declared
    // fallback: either way the bytes are what the reader should see, so they travel as an `HTML`
    // frame for this slot exactly as a local render's would.
    const paint =
      painted ?? (outcome.bytes.length ? frame('HTML', { s: slot }, outcome.bytes, true) : undefined)

    return {
      ...(paint ? { paint } : {}),
      ...(also.length ? { also } : {}),
    }
  }
}

/**
 * Which kinds change what the reader sees. Everything else — a template, a stylesheet, a module —
 * is what a client needs in order to apply one of these, and travels immediately even inside an
 * epoch, because staging a template nobody is waiting for would hold back the frame that needs it.
 */
const PAINTS = new Set<Frame['kind']>(['HTML', 'DELTA', 'DATA', 'PATCH'])
