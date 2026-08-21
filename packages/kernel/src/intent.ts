import type { EnvelopeContext } from './context.ts'
import type { Registry, StorePort } from './ports.ts'

/**
 * Intents: the only thing in this framework allowed to write.
 *
 * A render cannot write — that is enforced by the type of the context it gets — so until
 * something else could, `EffectSet.writes` was empty everywhere and every downstream
 * capability that depends on a write was blocked: invalidation, `revalidateTag`, an
 * optimistic epoch driven by a real mutation, and a route that can answer a POST.
 *
 * Two rules do the work, and they are the mirror of the two that govern plugins.
 *
 * **A write is declared, and an undeclared one throws.** `writes: ['cart']` is the whole set
 * of tags an intent may invalidate; `ctx.revalidate('orders')` from that intent is
 * `E_UNDECLARED_WRITE`. Unlike the read guard this is not dev-only, because an undeclared
 * write is not a missed optimisation — it is a cache invalidation nobody can predict from
 * reading the code, and predicting it from the code is the entire value of the effect graph.
 *
 * **The client never names server code.** An intent is addressed by an opaque id derived from
 * its module and export by the compiler (`intentId`), so renaming an export does not change
 * the wire and the wire does not disclose a function name. Resolving an id to an
 * implementation is the `registry` port.
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

export interface IntentContext extends EnvelopeContext {
  readonly phase: 'envelope'
  /**
   * Invalidate a declared tag. Returns the keys the store dropped, because an intent that
   * cannot see what it invalidated cannot report it either.
   */
  revalidate(tag: string): Promise<string[]>
  /** Which tags this intent actually invalidated, in order. */
  invalidated(): string[]
}

export interface IntentResult {
  /** Slots whose content this mutation is expected to have changed. Refreshed under the epoch. */
  refresh?: string[]
  /** Anything the caller wants back. Serialised into the ACK body. */
  data?: unknown
}

export interface Intent<I = unknown> {
  /** Human-readable, for logs and `weft why`. Never on the wire. */
  name: string
  /** Tags this intent may invalidate. The complete set; anything else throws. */
  writes: readonly string[]
  /** Request state this intent reads. Declared for the same reason a fragment's reads are. */
  reads?: readonly string[]
  /** Capabilities the caller must hold. Unchecked capabilities are refused, not waved through. */
  capabilities?: readonly string[]
  /** Parse and validate the raw payload. Throwing here is `E_INTENT_INPUT`, a 422, not a 500. */
  input?(raw: unknown): I
  /** Invalidate every declared tag on success without naming them again. */
  invalidatesAll?: boolean
  run(ctx: IntentContext, input: I): Promise<IntentResult | void> | IntentResult | void
}

export function defineIntent<I>(intent: Intent<I>): Intent<I> {
  return intent
}

/** Who may run this intent. Phase 7 signs them; this is the seam that will hold the check. */
export type CapabilityCheck = (
  ctx: EnvelopeContext,
  capabilities: readonly string[],
) => Promise<boolean> | boolean

export interface IntentDispatchOptions {
  registry: Registry
  store: StorePort
  /**
   * Required as soon as any intent declares a capability. An unchecked capability is a
   * capability that is not enforced, and defaulting to allow would make the declaration
   * decorative.
   */
  capabilities?: CapabilityCheck
}

export interface IntentDispatch {
  /** The intent, its outcome, and what it invalidated. Never a Response — that is the caller's. */
  run(id: string, raw: unknown, ctx: EnvelopeContext): Promise<IntentOutcome>
}

export interface IntentOutcome {
  ok: boolean
  id: string
  /** The intent's declared name, when it resolved. */
  name: string | null
  /** Named refusal, when it did not run or failed. */
  code?: string
  detail?: string
  invalidated: string[]
  /** Keys the store actually dropped. What a channel turns into STALE frames. */
  dropped: string[]
  refresh: string[]
  data?: unknown
}

export function createIntentDispatch(options: IntentDispatchOptions): IntentDispatch {
  return {
    async run(id, raw, base) {
      const intent = await options.registry.intent(id)
      if (!intent) {
        return refusal(id, null, 'E_NO_SUCH_INTENT', `no intent is registered under ${id}`)
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

      // Declared-and-not-yet-invalidated tags, for an intent that would rather not name each
      // one at the end of a successful run. Opt-in, because "invalidate everything I declared"
      // is a different statement from "invalidate what I actually touched".
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
