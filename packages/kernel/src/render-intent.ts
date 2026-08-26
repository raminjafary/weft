import type { SlotFrames, SlotRender } from './channel.ts'
import type { EnvelopeContext, RenderContext } from './context.ts'
import type { CapabilityCheck, IntentCredentials } from './intent.ts'
import type { IntentLimit, LimitPort, Registry } from './ports.ts'
import type { IntentVerifier } from './token.ts'

/**
 * Render intents: the other half of the design's phase 7, and the half that was waiting for a port.
 *
 * The authority half has existed since intents did. A client names an opaque id, the params are
 * validated against a schema, the caller is checked for the capabilities the entry declares, and the
 * call can be required to carry a signature this deployment minted. Every one of those is the intent
 * dispatch, and none of it is re-implemented here — `createRenderDispatch` calls the same
 * `CapabilityCheck`, the same `IntentVerifier` and the same `LimitPort`, because two gates that were
 * supposed to be the same gate are how one of them ends up weaker.
 *
 * What was missing is the **catalogue**: a set of renderable fragments addressable by opaque id. That
 * is not an authority feature. It is the module catalogue, and it needs something that turns a name
 * into a place — which is the registry port. Built before the registry existed, a catalogue would
 * have had one possible answer, and a catalogue with one answer is a function call with ceremony.
 *
 * With the registry it has the answer the design wanted: an id resolves to a renderable that this
 * process renders, or to one served by a region on another deployment, and the client cannot tell
 * which. That is the whole claim — "rendering as a service, by passing component names over the
 * wire" — with the two things that make it safe rather than alarming: the name on the wire is opaque
 * and derived, so it discloses no server code, and what comes back is checked before it reaches a
 * page.
 *
 * ## Why this is a REFRESH and not a frame of its own
 *
 * A refresh asks *give me this slot's current state*. A render intent asks *put this catalogue entry
 * in this slot*. Same answer, same forms, same epoch semantics, same surgical ladder — a rendered
 * fragment whose template the client already holds comes back as a delta, which is the entire reason
 * to do this over a channel rather than as a fetch that returns markup. A new frame kind would have
 * cost every entry carrying the frame table a few bytes to say something a header says.
 *
 * ## What it deliberately does not do
 *
 * It does not decide which slot the answer goes in. The dispatch validates the *entry*; whether the
 * named slot is a hole on the page this connection is showing is route knowledge, and a channel has
 * none — so the caller checks it, the same way it checks everything else about a route.
 */
export class RenderIntentError extends Error {
  code: string
  renderable: string

  constructor(code: string, renderable: string, message: string) {
    super(`${code} [${renderable}] — ${message}`)
    this.name = 'RenderIntentError'
    this.code = code
    this.renderable = renderable
  }
}

/** What a renderable is being asked for. */
export interface RenderRequest {
  /** The slot the answer is going into, so a renderable that addresses frames can name it. */
  slot: string
  /** The validated params. Whatever `input` returned, or the raw payload when it declared none. */
  params: unknown
  /**
   * The read surface a local renderable's loader runs against, and the one field here that does not
   * cross a boundary.
   *
   * Read-only by type, because a render cannot write — the same guarantee every other render in this
   * framework has, and the reason a render intent is not a mutation wearing a different hat. An entry
   * served by a region gets its declared reads *resolved* through this and handed over as values,
   * which is what the composition path already does and what makes a composed answer cacheable.
   */
  ctx: RenderContext
  /** Template versions the client already holds, so a renderable can answer with a delta. */
  held?: readonly string[]
  /** Set when the answer is being staged rather than painted. */
  epoch?: string
}

/**
 * A catalogue entry: something a client may ask to have rendered, by a name that is not its name.
 *
 * The declarations are the intent's, one for one, and that is the point rather than a shortcut. A
 * render is not a write, so it does not declare `writes` — but every other reason to refuse a call
 * applies unchanged, and an authority model that had a second vocabulary for renders would have two
 * places to get a capability wrong.
 */
export interface Renderable {
  /** Human-readable, for a log and for `weft why`. Never on the wire. */
  name: string
  /** Capabilities the caller must hold. Unchecked capabilities are refused, not waved through. */
  capabilities?: readonly string[]
  /** Reachable only with a signed, expiring token this deployment minted. */
  signed?: boolean
  /**
   * How much of this one caller may ask for.
   *
   * A render intent is the one call in this framework a client can make that costs server work
   * without writing anything, so it is the one that most wants a limit — and it gets the same one
   * intents get, counted against whatever this deployment counts against.
   */
  limit?: IntentLimit
  /**
   * Parse and validate the raw params. Throwing here is `E_RENDER_INPUT` — the caller sent something
   * this renderable does not accept — rather than a 500, which would say the server was at fault.
   */
  input?(raw: unknown): unknown
  /**
   * What goes in the slot: something this process renders, or frames somebody else produced.
   *
   * The same union a refresh already branches on. A local renderable returns a template and values
   * and the channel chooses the smallest form the client can apply; a renderable served by a region
   * returns that region's frames, already the smallest form *it* could choose, because it is the side
   * holding the template.
   */
  render(request: RenderRequest): Promise<SlotRender | SlotFrames> | SlotRender | SlotFrames
}

/** The catalogue, and the gates a render request passes — the same ones an intent does. */
export interface RenderDispatchOptions {
  registry: Registry
  /** Required as soon as a renderable declares a capability. */
  capabilities?: CapabilityCheck
  /** Required as soon as a renderable declares `signed`. */
  verify?: IntentVerifier
  /** Required as soon as a renderable declares a limit. */
  limits?: LimitPort
}

/** What a render request produced, or the refusal that replaced it. */
export interface RenderIntentOutcome {
  ok: boolean
  /** The opaque id that was asked for. */
  id: string
  /** The entry's declared name, when it resolved. */
  name: string | null
  slot: string
  code?: string
  detail?: string
  retryAfterMs?: number
  /** What to put in the slot. Absent on every refusal. */
  source?: SlotRender | SlotFrames
}

/** Renders a fragment a client named by opaque id. Deliberately not the intent path. */
export interface RenderDispatch {
  run(
    request: {
      id: string
      slot: string
      raw: unknown
      /** The read surface the entry's own loader runs against. See `RenderRequest.ctx`. */
      ctx: RenderContext
      held?: readonly string[]
      epoch?: string
    },
    /**
     * The context the *gates* run against, which is the envelope's.
     *
     * Two contexts because they answer two questions. A capability check resolves a subject and a
     * verifier reads a token, and both of those happen where a request can still be refused; the
     * entry's own loader runs after all of that and may only read. Handing one context to both would
     * mean a render that could write, which is the property this framework does not have anywhere
     * else and should not acquire here.
     */
    ctx: EnvelopeContext,
    credentials?: IntentCredentials,
  ): Promise<RenderIntentOutcome>
}

/**
 * A dispatch over a catalogue.
 *
 * Separate from intents because an intent is the only thing allowed to *write* and a render is the
 * one thing that cannot — sharing the path would be one gate answering two questions.
 */
export function createRenderDispatch(options: RenderDispatchOptions): RenderDispatch {
  return {
    async run(asked, base, credentials) {
      const { id, slot } = asked
      if (!options.registry.renderable) {
        return refusal(
          id,
          slot,
          null,
          'E_NO_CATALOGUE',
          'no registry able to resolve a renderable is bound, and a client naming one needs it',
        )
      }
      const entry = await options.registry.renderable(id)
      if (!entry) {
        // Deny by default, and say nothing about what else is in the catalogue: an id is opaque
        // precisely so that guessing at one learns nothing.
        return refusal(id, slot, null, 'E_NO_SUCH_RENDERABLE', `nothing in the catalogue answers ${id}`)
      }

      /**
       * The same three gates as an intent, in the same order and for the same reasons.
       *
       * Capacity first because it is the cheapest and protects the other two. Then authenticity —
       * whether this deployment issued the call at all. Then authority — who is making it. Reversed,
       * a caller with the right grant would learn whether their forged token was the problem.
       */
      if (entry.limit) {
        if (!options.limits) {
          return refusal(
            id,
            slot,
            entry.name,
            'E_NO_RATE_LIMIT',
            `${entry.name} declares a limit and no limits port is bound`,
          )
        }
        const decision = await options.limits.check({
          id,
          intent: entry.name,
          limit: entry.limit,
          subject: await base.user(),
          header: (key) => base.header(key),
          cookie: (key) => base.cookie(key),
        })
        if (!decision.ok) {
          return {
            ...refusal(
              id,
              slot,
              entry.name,
              'E_RATE_LIMITED',
              `${entry.limit.max} per ${entry.limit.windowMs}ms`,
            ),
            ...(decision.retryAfterMs === undefined ? {} : { retryAfterMs: decision.retryAfterMs }),
          }
        }
      }

      if (entry.signed) {
        if (!options.verify) {
          return refusal(
            id,
            slot,
            entry.name,
            'E_NO_VERIFIER',
            `${entry.name} is signed and no verifier is bound`,
          )
        }
        const verified = await options.verify.verify({
          id,
          raw: asked.raw,
          subject: await base.user(),
          ...(credentials?.token ? { token: credentials.token } : {}),
        })
        if (!verified.ok) return refusal(id, slot, entry.name, verified.code, verified.detail)
      }

      if (entry.capabilities?.length) {
        if (!options.capabilities) {
          return refusal(
            id,
            slot,
            entry.name,
            'E_NO_CAPABILITY_CHECK',
            `${entry.name} declares ${entry.capabilities.join(',')} and no check is bound`,
          )
        }
        if (!(await options.capabilities(base, entry.capabilities))) {
          return refusal(id, slot, entry.name, 'E_CAPABILITY_DENIED', entry.capabilities.join(','))
        }
      }

      let params: unknown = asked.raw
      if (entry.input) {
        try {
          params = entry.input(asked.raw)
        } catch (error) {
          return refusal(id, slot, entry.name, 'E_RENDER_INPUT', reasonOf(error))
        }
      }

      try {
        const source = await entry.render({
          slot,
          params,
          ctx: asked.ctx,
          ...(asked.held ? { held: asked.held } : {}),
          ...(asked.epoch ? { epoch: asked.epoch } : {}),
        })
        return { ok: true, id, name: entry.name, slot, source }
      } catch (error) {
        // A renderable that threw degrades the one slot it was for. A render intent is one hole on a
        // page the reader is already looking at, and failing the connection over it would throw away
        // more than it protects.
        const code = error instanceof RenderIntentError ? error.code : 'E_RENDER_FAILED'
        return refusal(id, slot, entry.name, code, reasonOf(error))
      }
    },
  }
}

function refusal(
  id: string,
  slot: string,
  name: string | null,
  code: string,
  detail: string,
): RenderIntentOutcome {
  return { ok: false, id, name, slot, code, detail }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
