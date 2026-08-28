import { frame, str, type Frame } from '@weftjs/warp'
import type { Channel, SlotFrames, SlotRender, WarmHandler } from './channel.ts'
import type { StorePort, TelemetryPort } from './ports.ts'
import { surgicalRefresh, type RefreshTtl } from './refresh.ts'

/**
 * A whole route, staged and painting nothing — which is what the design's frame table always said
 * `WARM` was for: "stage data for a route, do not paint".
 *
 * This is `REFRESH` for a page the client is not on, and the two differences are the whole of it.
 * The **held map is not touched**, because what this client is showing has not changed: writing the
 * target's bases into it would make the next refresh of the page they are still looking at a delta
 * against a render they have never seen. And nothing is committed — the client holds the epoch and
 * commits it when the reader clicks, or discards it when they do not.
 *
 * Where the design's promise lands is the form each region comes back in. Two pages on one route
 * share a template, so switching between them is a `delta`: the changed values and nothing else,
 * for a page the reader has not been to yet. A region whose template this client has never held
 * comes back as markup, which is the same floor every other path degrades to.
 *
 * **Its own module and its own byte entry.** Written into the channel it took `entry-transport.ts`
 * 108 bytes past a watermark set before route staging existed, and the rule is that a new
 * capability gets an entry of its own rather than somebody else's headroom. The hub keeps five
 * lines: a `WARM` carrying `at=` is handed here, and a hub with no staging bound refuses by name.
 */
export interface StagedRoute {
  /** The pattern that matched, for a client that wants to name what it staged. */
  route: string
  /**
   * Whether the target shares this connection's shell.
   *
   * The decision only the server can make, because only the server knows both shells. A different
   * shell has different holes, so its regions cannot be swapped into the ones on screen — and a
   * page assembled out of two layouts is worse than a document request.
   */
  shared: boolean
  title?: string
  /** The stylesheet the target links, so a commit can put the cascade in place before it paints. */
  css?: string
  /** Routes worth staging from the target once it is committed. A profile's own numbers. */
  next?: readonly string[]
  /**
   * What each of the target's regions is, either as something to render here or as frames somebody
   * else produced.
   *
   * The second shape is a region on another deployment, and it is the same union a refresh already
   * branches on rather than a second mechanism. Frames from elsewhere are already the smallest form
   * their producer could send — the region was told what this client holds and chose on its own side
   * — so choosing again here would mean re-deriving a delta against a template this process does not
   * have. What the stage adds is the epoch, on the one frame that paints.
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
 * Answers `WARM at=`, which is a route staged and painted nowhere.
 *
 * Two decisions live here because only this side can make them: whether the target shares the
 * client's shell — a different document has different holes — and what each region's next state is,
 * through the *same loaders* a document request would run.
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
      /**
       * The epoch comes back on a refusal too, and leaving it off cost two seconds a navigation.
       *
       * An epoch is where staged values are put, so a refusal has nowhere to put anything and it
       * looked like there was nothing to echo. But that is not the only thing an epoch is: it is
       * also the name the client gave this question, and the only way it can tell which of its
       * questions an answer belongs to. Without it the client could not match `form=document` to
       * the route it was staging, so the promise waiting on that route was never settled — it sat
       * out the full grace period and *then* fetched the document, on every hover over a link to a
       * page on a different shell. The fallback worked. It arrived two seconds late.
       */
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
      /**
       * A region from another deployment, staged as it arrived.
       *
       * Everything it sent that paints carries the epoch, so a commit flips this region with all the
       * others; everything that does not — a template, a stylesheet, a module — travels immediately,
       * because holding back the thing a frame needs in order to apply would only delay the frame.
       * The region decided that split itself, which is right: only the side that produced the frames
       * knows which of them is the picture.
       */
      if (!('ir' in source)) {
        if (source.also) out.push(...source.also)
        if (source.paint) out.push({ ...source.paint, header: { ...source.paint.header, epoch } })
        options.telemetry?.measure('channel.stage', 1, { slot, form: 'region', at: request.path })
        continue
      }
      // The base this client holds for the *same slot on the page it is on*, which is only usable
      // when the template is the same one — and `surgicalRefresh` checks exactly that before it
      // diffs. Two categories of one route share a template; two different pages do not.
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
        // Every frame this function emits carries the epoch, so nothing it chooses may be a
        // form whose addresses another commit can move.
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
