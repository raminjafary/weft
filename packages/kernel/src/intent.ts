import type { EnvelopeContext } from './context.ts'
import type { IntentLimit, LimitPort, Registry, StorePort } from './ports.ts'
import type { IntentVerifier } from './token.ts'

/**
 * Intents: the only thing in this framework allowed to write. A write is declared and an
 * undeclared one throws, not in dev only. The client never names server code — an intent is
 * addressed by an opaque id. See `spec/kernel/intents.md`.
 */
export class IntentError extends Error {
  code: string
  intent: string

  constructor(code: string, intent: string, message: string) {
    super(`${code} [${intent}] — ${message}`)
    this.name = 'IntentError'
    this.code = code
    this.intent = intent
  }
}

/** What an intent runs against: the envelope, still open, plus the one thing a render cannot do. */
export interface IntentContext extends EnvelopeContext {
  readonly phase: 'envelope'
  /** Invalidate a declared tag. Returns the keys the store dropped. */
  revalidate(tag: string): Promise<string[]>
  /** Which tags this intent actually invalidated, in order. */
  invalidated(): string[]
}

/** The outcome plus everything the dispatch decided: the refusal, the status, the tags. */
export interface IntentResult {
  /** Slots whose content this mutation is expected to have changed. Refreshed under the epoch. */
  refresh?: string[]
  /** Anything the caller wants back. Serialised into the ACK body. */
  data?: unknown
}

/** A mutation, and the only thing in this framework allowed to write. `writes` is the complete set; an undeclared one throws. */
export interface Intent<I = unknown> {
  /** Human-readable, for logs and `weft why`. Never on the wire. */
  name: string
  /** Tags this intent may invalidate. The complete set; anything else throws. */
  writes: readonly string[]
  /** Request state this intent reads. Declared for the same reason a fragment's reads are. */
  reads?: readonly string[]
  /** Capabilities the caller must hold. Unchecked capabilities are refused, not waved through. */
  capabilities?: readonly string[]
  /**
   * Reachable only with a signed, expiring token this deployment minted. A different question
   * from a capability, and both are asked. Declared and unverifiable is `E_NO_VERIFIER`.
   */
  signed?: boolean
  /** Parse and validate the raw payload. Throwing here is `E_INTENT_INPUT`, a 422, not a 500. */
  input?(raw: unknown): I
  /**
   * How much traffic this mutation can take, over how long. Deliberately cannot say *whose* — that
   * is the `limits` port's job. Declared and unenforceable is `E_NO_RATE_LIMIT`.
   */
  limit?: IntentLimit
  /** Invalidate every declared tag on success without naming them again. */
  invalidatesAll?: boolean
  /**
   * The mutation itself — the only thing allowed to change anything. `ctx` is the one context
   * with a `revalidate` on it, which is how "a render cannot write" is enforced by the type
   * system. Throwing is a 500; refusing input is `input`'s job and is a 422.
   */
  run(ctx: IntentContext, input: I): Promise<IntentResult | void> | IntentResult | void
}

/** An identity function that exists for the types: it is what makes `writes` checkable. */
export function defineIntent<I>(intent: Intent<I>): Intent<I> {
  return intent
}

/** Who may run this intent. `createCapabilityModel` in `authority.ts` is the model behind it. */
export type CapabilityCheck = (
  ctx: EnvelopeContext,
  capabilities: readonly string[],
) => Promise<boolean> | boolean

/** What a dispatch needs: the closed set of intents, and the gates every call passes. */
export interface IntentDispatchOptions {
  registry: Registry
  store: StorePort
  /** Required as soon as any intent declares a capability, or the declaration is decorative. */
  capabilities?: CapabilityCheck
  /** Required as soon as any intent declares `signed`: an intent that reads as authorised and
   * is not is worse than one that reads as open. */
  verify?: IntentVerifier
  /** Required as soon as any intent declares a limit — what a call is counted against is a
   * property of the deployment. */
  limits?: LimitPort
}

/** What the caller presented that is not the payload. Credentials travel beside it, never in it. */
export interface IntentCredentials {
  /** The signed token, from `INTENT t=` over a channel or the token field of a form post. */
  token?: string
}

/** Runs one intent by its opaque id, having checked who may. */
export interface IntentDispatch {
  /** The intent, its outcome, and what it invalidated. Never a Response — that is the caller's. */
  run(id: string, raw: unknown, ctx: EnvelopeContext, credentials?: IntentCredentials): Promise<IntentOutcome>
}

/** What the intent itself returned, and what it invalidated on the way. */
export interface IntentOutcome {
  ok: boolean
  id: string
  /** The intent's declared name, when it resolved. */
  name: string | null
  /** Named refusal, when it did not run or failed. */
  code?: string
  detail?: string
  /**
   * Milliseconds until this call is worth making again. On the field rather than in the detail,
   * so both bindings have somewhere to put it — a `Retry-After` header, a header on `ACK`.
   */
  retryAfterMs?: number
  invalidated: string[]
  /** Keys the store actually dropped. What a channel turns into STALE frames. */
  dropped: string[]
  refresh: string[]
  data?: unknown
}

/** A dispatch over a closed set. An id nothing answers is `E_NO_SUCH_INTENT`, never a 500. */
export function createIntentDispatch(options: IntentDispatchOptions): IntentDispatch {
  return {
    async run(id, raw, base, credentials) {
      const intent = await options.registry.intent(id)
      if (!intent) {
        return refusal(id, null, 'E_NO_SUCH_INTENT', `no intent is registered under ${id}`)
      }

      // The limit before either of them: cheapest, and protects both. Capacity, then
      // authenticity, then authority — each more expensive, each reached only if the last passed.
      if (intent.limit) {
        if (!options.limits) {
          return refusal(
            id,
            intent.name,
            'E_NO_RATE_LIMIT',
            `${intent.name} declares a limit of ${intent.limit.max} per ${intent.limit.windowMs}ms and ` +
              `no limits port is bound. What a call is counted against is a deployment's decision`,
          )
        }
        const decision = await options.limits.check({
          id,
          intent: intent.name,
          limit: intent.limit,
          subject: await base.user(),
          // Through the context: a limit counted against a cookie has read that cookie.
          header: (key) => base.header(key),
          cookie: (key) => base.cookie(key),
        })
        if (!decision.ok) {
          // What the call was counted against is not said back: it identifies the caller.
          return {
            ...refusal(
              id,
              intent.name,
              'E_RATE_LIMITED',
              `${intent.limit.max} per ${intent.limit.windowMs}ms`,
            ),
            ...(decision.retryAfterMs === undefined ? {} : { retryAfterMs: decision.retryAfterMs }),
          }
        }
      }

      // The signature before the grant: authenticity first, then who is making the call.
      // Reversed, a denial would tell a caller whether their forged token was the problem.
      if (intent.signed) {
        if (!options.verify) {
          return refusal(
            id,
            intent.name,
            'E_NO_VERIFIER',
            `${intent.name} is signed and no verifier is bound`,
          )
        }
        const verified = await options.verify.verify({
          id,
          raw,
          subject: await base.user(),
          ...(credentials?.token ? { token: credentials.token } : {}),
        })
        if (!verified.ok) return refusal(id, intent.name, verified.code, verified.detail)
      }

      if (intent.capabilities?.length) {
        if (!options.capabilities) {
          return refusal(
            id,
            intent.name,
            'E_NO_CAPABILITY_CHECK',
            `${intent.name} declares ${intent.capabilities.join(',')} and no check is bound`,
          )
        }
        if (!(await options.capabilities(base, intent.capabilities))) {
          return refusal(id, intent.name, 'E_CAPABILITY_DENIED', intent.capabilities.join(','))
        }
      }

      let input: unknown = raw
      if (intent.input) {
        try {
          input = intent.input(raw)
        } catch (error) {
          return refusal(id, intent.name, 'E_INTENT_INPUT', reasonOf(error))
        }
      }

      const declared = new Set(intent.writes)
      const invalidated: string[] = []
      const dropped: string[] = []
      const ctx: IntentContext = {
        ...base,
        phase: 'envelope',
        invalidated: () => [...invalidated],
        async revalidate(tag) {
          if (!declared.has(tag)) {
            throw new IntentError(
              'E_UNDECLARED_WRITE',
              intent.name,
              `invalidated ${tag} without declaring it. Add it to writes: [...]`,
            )
          }
          invalidated.push(tag)
          const keys = await options.store.invalidate([tag])
          dropped.push(...keys)
          return keys
        },
      }

      let result: IntentResult | void
      try {
        result = await intent.run(ctx as IntentContext, input as never)
      } catch (error) {
        const code = error instanceof IntentError ? error.code : 'E_INTENT_FAILED'
        return {
          ...refusal(id, intent.name, code, reasonOf(error)),
          invalidated,
          dropped,
        }
      }

      // Declared-and-not-yet-invalidated tags. Opt-in: "invalidate everything declared" is a
      // different statement from "invalidate what was actually touched".
      if (intent.invalidatesAll) {
        for (const tag of intent.writes) {
          if (invalidated.includes(tag)) continue
          invalidated.push(tag)
          dropped.push(...(await options.store.invalidate([tag])))
        }
      }

      return {
        ok: true,
        id,
        name: intent.name,
        invalidated,
        dropped: [...new Set(dropped)],
        refresh: result?.refresh ?? [],
        ...(result && 'data' in result ? { data: result.data } : {}),
      }
    },
  }
}

function refusal(id: string, name: string | null, code: string, detail: string): IntentOutcome {
  return { ok: false, id, name, code, detail, invalidated: [], dropped: [], refresh: [] }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
