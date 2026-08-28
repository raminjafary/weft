import { frame, type Frame } from '@weftjs/warp'
import type { Channel, WarmHandler } from './channel.ts'
import type { TelemetryPort } from './ports.ts'

/**
 * Lazy plan extension: the part of the plan a client does not have yet, asked for and answered —
 * everything that would otherwise cost a request to learn. `WARM plan=` asks about a subtree; a
 * `PLAN` also arrives unasked when a channel opens. See `spec/client/navigation.md`.
 */
export interface DiscoveredRoute {
  /** The pattern, as the route table spells it: `/product/:sku`, `/checkout/*`. */
  pattern: string
  /** Which document it renders into, by the shell template's version — "is this the same document I am in". */
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

/** What came back: the prefix, the routes described, and whether that was all of them. */
export interface PlanExtension {
  /** What was asked about, echoed. `''` for the unasked frame that follows a handshake. */
  prefix: string
  routes: readonly DiscoveredRoute[]
  /** False when the answer was truncated, so the client asks again rather than deciding silently. */
  complete?: boolean
}

/** A prefix somebody asked about, and the connection asking. */
export interface ExtendRequest {
  /** The subtree asked about. Absent for the frame sent when a channel opens. */
  prefix?: string
  channel: Channel
}

/** What a hub is given: the handler for the `plan` grain of a `WARM`, and the frames a connection is handed when it opens. */
export interface PlanExtender {
  /** Answers `WARM plan=<prefix>`. */
  warm: WarmHandler
  /** Answers nothing: what a connection is told when it opens, because it cannot ask. */
  open(channel: Channel): Promise<Frame[]>
}

/** How a prefix becomes routes. Describing runs no loader, which is the difference from staging. */
export interface DiscoveryOptions {
  resolve(request: ExtendRequest): Promise<PlanExtension | null> | PlanExtension | null
  /** How many routes one frame may carry. A table of four thousand routes is not a prefetch hint. */
  max?: number
  telemetry?: TelemetryPort
}

/** How many routes one answer may describe. A truncated answer says so rather than looking complete. */
export const DISCOVER_MAX = 32

/** Answers `WARM plan=` with a `PLAN`. A prefix matching nothing is an empty answer, not a silence. */
export function createExtender(options: DiscoveryOptions): PlanExtender {
  const max = options.max ?? DISCOVER_MAX

  const answer = async (request: ExtendRequest): Promise<Frame[]> => {
    const extension = await options.resolve(request)
    if (!extension) {
      // A prefix that matches no route is an answer, and an empty one. Only the unasked frame is
      // silent — a handshake answering "nothing here" would say it on every connection.
      if (request.prefix === undefined) return []
      return [frame('PLAN', { p: request.prefix, n: 0, complete: true })]
    }
    // Truncation is reported rather than hidden: a silent cap reads as "that is the whole subtree".
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

/** One `PLAN` frame. A JSON body, not headers: the routes are a list of records. */
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
