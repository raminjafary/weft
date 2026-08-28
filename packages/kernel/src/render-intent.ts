import type { SlotFrames, SlotRender } from './channel.ts'
import type { EnvelopeContext, RenderContext } from './context.ts'
import type { CapabilityCheck, IntentCredentials } from './intent.ts'
import type { IntentLimit, LimitPort, Registry } from './ports.ts'
import type { IntentVerifier } from './token.ts'

/**
 * Render intents: a catalogue of fragments addressable by opaque id, gated the same way an intent
 * is — `createRenderDispatch` calls the same `CapabilityCheck`, `IntentVerifier` and `LimitPort`.
 * `REFRESH` with a source named rather than a frame of its own, for the same reason a render
 * intent gets the same surgical ladder. See `spec/kernel/composition.md`.
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
   * The read surface a local renderable's loader runs against. Read-only by type: a render
   * cannot write, the same guarantee every other render has.
   */
  ctx: RenderContext
  /** Template versions the client already holds, so a renderable can answer with a delta. */
  held?: readonly string[]
  /** Set when the answer is being staged rather than painted. */
  epoch?: string
}

/**
 * A catalogue entry: something a client may ask to have rendered, by a name that is not its name.
 * The declarations are the intent's, one for one — a render does not declare `writes`, but every
 * other reason to refuse a call applies unchanged.
 */
export interface Renderable {
  /** Human-readable, for a log and for `weft why`. Never on the wire. */
  name: string
  /** Capabilities the caller must hold. Unchecked capabilities are refused, not waved through. */
  capabilities?: readonly string[]
  /** Reachable only with a signed, expiring token this deployment minted. */
  signed?: boolean
  /** How much of this one caller may ask for — the one call that costs server work without writing anything. */
  limit?: IntentLimit
  /** Parse and validate the raw params. Throwing here is `E_RENDER_INPUT`, not a 500. */
  input?(raw: unknown): unknown
  /**
   * What goes in the slot: something this process renders, or frames somebody else produced — the
   * same union a refresh already branches on.
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
     * The context the *gates* run against, which is the envelope's — the entry's own loader gets a
     * different one that may only read. See `spec/kernel/authority.md`.
     */
    ctx: EnvelopeContext,
    credentials?: IntentCredentials,
  ): Promise<RenderIntentOutcome>
}

/**
 * A dispatch over a catalogue. Separate from intents: an intent is the only thing allowed to
 * *write*, and a render is the one thing that cannot.
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
        // Deny by default, and say nothing about the catalogue: an id is opaque so guessing learns nothing.
        return refusal(id, slot, null, 'E_NO_SUCH_RENDERABLE', `nothing in the catalogue answers ${id}`)
      }

      // The same three gates as an intent, in the same order: capacity, authenticity, authority.
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
        // A renderable that threw degrades the one slot it was for, rather than failing the
        // connection.
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
