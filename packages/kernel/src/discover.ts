import { frame, type Frame } from '@weft/warp'
import type { Channel, WarmHandler } from './channel.ts'
import type { TelemetryPort } from './ports.ts'

/**
 * Lazy plan extension: the part of the plan a client does not have yet, asked for and answered.
 *
 * React Router's Fog of War applies lazy discovery to routes and stops there. Here the plan is
 * already the unit of knowledge, so extending it lazily generalises: what arrives is not a route
 * table but everything a client would otherwise have to make a request to learn — which document
 * a route renders into, what its regions are called, which templates they need, what stylesheet it
 * links, and where readers of it go next.
 *
 * The point is what that lets a client skip. Today a link the reader has not clicked is staged by
 * asking the server to render it (`WARM at=`), and the answer may be `form=document` — a whole
 * round trip and a whole render to discover that the target uses a different shell and cannot be
 * swapped in as regions. With the plan extended, the client knows that before it asks: it fetches
 * the document instead, and pays neither.
 *
 * Two grains, one frame. `WARM plan=/checkout/*` asks about a subtree. A `PLAN` also arrives
 * **unasked**, once, when a channel opens — carrying the route this connection is on and where its
 * readers go next, which is how a page that arrived by an ordinary document request learns what the
 * profile recorded. Before this there was nowhere for that hint to travel: `NAV next=` only reaches
 * a client that already staged something over the channel, so the pages most likely to benefit —
 * first visits — were exactly the ones that never heard it.
 */
export interface DiscoveredRoute {
  /** The pattern, as the route table spells it: `/product/:sku`, `/checkout/*`. */
  pattern: string
  /**
   * Which document it renders into, by the shell template's version.
   *
   * The version rather than a name, because the client's question is only ever "is this the same
   * document I am in" — and comparing versions is an answer it can act on without knowing what any
   * shell is called.
   */
  shell: string
  /** True when this route's shell is the one this connection's page uses. */
  shared: boolean
  /** Region names, in the order the plan places them. */
  slots?: readonly string[]
  /** The stylesheet the route links, so a client can preload it before it is needed. */
  css?: string
  /** Template versions its regions need. A client asks for the ones it does not hold with `WARM tpl=`. */
  tpl?: readonly string[]
  /** Where readers of this route go next, from the profile. Worth staging once this route commits. */
  next?: readonly string[]
}

export interface PlanExtension {
  /** What was asked about, echoed. `''` for the unasked frame that follows a handshake. */
  prefix: string
  routes: readonly DiscoveredRoute[]
  /**
   * False when the answer was truncated. A client that believes it holds the whole subtree and
   * does not would silently decide a route is not this application's, which is worse than a client
   * that knows to ask again.
   */
  complete?: boolean
}

export interface ExtendRequest {
  /**
   * The subtree asked about. Absent for the frame sent when a channel opens, which means "where
   * this connection is, and where its readers go from there".
   */
  prefix?: string
  channel: Channel
}

/**
 * What a hub is given: the handler for the `plan` grain of a `WARM`, and the frames a connection is
 * handed when it opens.
 *
 * Frames rather than records, which is the shape every hook the channel takes has — so the channel
 * needs none of this module at runtime, and a deployment that never extends a plan never imports it.
 */
export interface PlanExtender {
  /** Answers `WARM plan=<prefix>`. */
  warm: WarmHandler
  /** Answers nothing: what a connection is told when it opens, because it cannot ask. */
  open(channel: Channel): Promise<Frame[]>
}

export interface DiscoveryOptions {
  resolve(request: ExtendRequest): Promise<PlanExtension | null> | PlanExtension | null
  /** How many routes one frame may carry. A table of four thousand routes is not a prefetch hint. */
  max?: number
  telemetry?: TelemetryPort
}

export const DISCOVER_MAX = 32

export function createExtender(options: DiscoveryOptions): PlanExtender {
  const max = options.max ?? DISCOVER_MAX

  const answer = async (request: ExtendRequest): Promise<Frame[]> => {
    const extension = await options.resolve(request)
    if (!extension) {
      // A prefix that matches no route is an answer, and an empty one: the client learns that this
      // subtree is not this application's and stops asking. Only the unasked frame is silent,
      // because a handshake that answered "nothing here" would say it on every connection.
      if (request.prefix === undefined) return []
      return [frame('PLAN', { p: request.prefix, n: 0, complete: true })]
    }
    // Truncation is reported rather than hidden. A silent cap reads to the client as "that is the
    // whole subtree", which is the one wrong thing it could conclude.
    const routes = extension.routes.slice(0, max)
    options.telemetry?.measure('channel.discover', routes.length, {
      prefix: extension.prefix || '(handshake)',
    })
    return [
      planFrame({
        ...extension,
        routes,
        complete: (extension.complete ?? true) && routes.length === extension.routes.length,
      }),
    ]
  }

  return {
    warm: (asked) => answer({ prefix: asked.value, channel: asked.channel }),
    open: (channel) => answer({ channel }),
  }
}

/**
 * One `PLAN` frame.
 *
 * The routes are a JSON body rather than headers because they are a list of records and a header
 * set is neither — and text, so the same frame is readable in the text framing a tool uses.
 */
export function planFrame(extension: PlanExtension): Frame {
  const body = new TextEncoder().encode(JSON.stringify(extension.routes))
  return frame(
    'PLAN',
    {
      ...(extension.prefix ? { p: extension.prefix } : {}),
      n: extension.routes.length,
      complete: extension.complete ?? true,
    },
    body,
    true,
  )
}
