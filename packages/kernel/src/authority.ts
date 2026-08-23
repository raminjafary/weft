import type { EnvelopeContext } from './context.ts'
import type { CapabilityCheck } from './intent.ts'
import type { TelemetryPort } from './ports.ts'

/**
 * Who may run an intent, implemented rather than declared.
 *
 * `CapabilityCheck` has been the seam since intents existed, and a seam with nothing behind it
 * refuses everything that declares a capability — which is honest and is not a capability model.
 * This is the model: a caller holds a set of grants, an intent names the capabilities it requires,
 * and the dispatch runs only when every one of them is held.
 *
 * Three decisions are the whole of it, and each one is the opposite of a default that would have
 * been easier.
 *
 * **Deny by default, and deny on failure.** A grant source that throws is a denial, not an
 * allow-through: an authority check that fails open turns an outage in the identity service into
 * an escalation for every caller at once. The refusal names the source rather than the caller.
 *
 * **Every capability, not any of them.** `capabilities: ['cart:write', 'order:create']` means both.
 * The alternative reading — hold any one of them — makes a longer declaration weaker than a
 * shorter one, which is not what anybody writing the list means by adding to it.
 *
 * **A grant that matches everything is refused at construction.** `*` would make the declaration
 * decorative, which is the same argument that makes an unchecked capability a refusal rather than
 * an allow. What an operator actually wants — a role that holds everything the application
 * declares — is expressible as the list, and the list is reviewable: the front door has the
 * complete declared set from the intent manifest, so it can check a role table against it and
 * refuse a grant naming a capability nothing declares.
 */

/**
 * A capability a caller holds. Either exact (`cart:write`) or a namespace (`cart:*`), which covers
 * every capability under that colon and nothing above it.
 */
export type Grant = string

export interface Grants {
  /** Who this is, for the audit line. Null for a caller with no session. */
  subject: string | null
  capabilities: readonly Grant[]
  /** Where the grants came from — a role name, a token, a table. For the audit line, never the wire. */
  via?: string
}

/**
 * Where a caller's grants come from.
 *
 * An `EnvelopeContext` rather than a request, because that is what the dispatch has and because
 * reading identity through it taints `identity` — so a deployment whose grants depend on who is
 * asking cannot accidentally have that read go unrecorded.
 */
export type GrantSource = (ctx: EnvelopeContext) => Promise<Grants> | Grants

export interface Decision {
  allowed: boolean
  subject: string | null
  via?: string
  required: readonly string[]
  held: readonly Grant[]
  /** What was asked for and not held. Empty on an allow. */
  missing: readonly string[]
  /** Set when the decision was a denial for a reason other than a missing grant. */
  code?: string
}

export interface CapabilityOptions {
  grants: GrantSource
  /**
   * Grants every caller holds, session or not. The place a public capability goes: an intent that
   * anybody may run still declares what it is, and the declaration is what a later change argues
   * with.
   */
  ambient?: readonly Grant[]
  /**
   * Every decision, allowed and denied both.
   *
   * Both, because a log of denials only is a log in which a successful privilege escalation looks
   * exactly like silence.
   */
  audit?(decision: Decision): void
  telemetry?: TelemetryPort
}

export class AuthorityError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(`${code} — ${message}`)
    this.name = 'AuthorityError'
    this.code = code
  }
}

/** True when `grant` covers `capability`. Exact, or a namespace ending in `:*`. */
export function covers(grant: Grant, capability: string): boolean {
  if (grant === capability) return true
  if (!grant.endsWith(':*')) return false
  return capability.startsWith(grant.slice(0, -1))
}

/**
 * The grants a set of role names amounts to.
 *
 * Exported because the closed-set check needs it: the front door compares what a role table can
 * ever grant against what the manifest declares, and a capability nothing can grant is a
 * deployment where an intent is permanently 403 with nothing saying so.
 */
export function grantsOf(roles: readonly string[], table: Record<string, readonly Grant[]>): Grant[] {
  const out = new Set<Grant>()
  for (const role of roles) for (const grant of table[role] ?? []) out.add(grant)
  return [...out]
}

function assertUsable(grants: readonly Grant[], where: string): void {
  for (const grant of grants) {
    if (grant === '*' || grant === '**' || grant === ':*') {
      throw new AuthorityError(
        'E_GRANT_TOO_BROAD',
        `${where} grants '${grant}', which matches every capability and makes declaring one decorative. ` +
          `List the capabilities instead — the intent manifest knows the complete set, so a list is reviewable`,
      )
    }
    if (!grant.length) {
      throw new AuthorityError('E_GRANT_EMPTY', `${where} contains an empty grant`)
    }
  }
}

export interface CapabilityModel {
  /** The `CapabilityCheck` the intent dispatch takes. */
  readonly check: CapabilityCheck
  /** The same decision, with the reasons on it. What an audit page and a test read. */
  decide(ctx: EnvelopeContext, capabilities: readonly string[]): Promise<Decision>
  /** Decisions taken, newest last, capped. For devtools; never for a policy decision. */
  recent(): readonly Decision[]
}

const RECENT = 50

export function createCapabilityModel(options: CapabilityOptions): CapabilityModel {
  const ambient = [...(options.ambient ?? [])]
  assertUsable(ambient, 'ambient')
  const recent: Decision[] = []

  const record = (decision: Decision): Decision => {
    options.audit?.(decision)
    options.telemetry?.measure('authority.decision', decision.allowed ? 1 : 0, {
      allowed: String(decision.allowed),
      required: decision.required.join(','),
      ...(decision.code ? { code: decision.code } : {}),
    })
    recent.push(decision)
    while (recent.length > RECENT) recent.shift()
    return decision
  }

  const decide = async (ctx: EnvelopeContext, required: readonly string[]): Promise<Decision> => {
    let grants: Grants
    try {
      grants = await options.grants(ctx)
    } catch (error) {
      // An identity service that is down is not a caller who is allowed. The refusal is about the
      // source rather than about the subject, because there is no subject to name.
      return record({
        allowed: false,
        subject: null,
        required: [...required],
        held: [],
        missing: [...required],
        code: 'E_GRANTS_UNAVAILABLE',
        ...(error instanceof Error ? { via: error.message } : {}),
      })
    }

    const held = [...new Set([...ambient, ...grants.capabilities])]
    const missing = required.filter((capability) => !held.some((grant) => covers(grant, capability)))
    return record({
      allowed: missing.length === 0,
      subject: grants.subject,
      ...(grants.via ? { via: grants.via } : {}),
      required: [...required],
      held,
      missing,
    })
  }

  return {
    check: async (ctx, capabilities) => (await decide(ctx, capabilities)).allowed,
    decide,
    recent: () => [...recent],
  }
}

/**
 * Grants from the session's identity, through a role table.
 *
 * The shape a deployment usually wants and the smallest thing that is a real model: identity comes
 * from the session port, roles come from whatever the application knows, and the table says what a
 * role holds. Anonymous is a subject of `null` with the `anonymous` role, which is a row an
 * operator can see and edit rather than a branch in the framework.
 */
export interface RoleGrantOptions {
  /**
   * What a subject's roles are. An unknown subject has none, which is a denial and not an error.
   *
   * Never called with a null subject: a caller with no session has the anonymous role, which is a
   * row in the table an operator can see rather than a case every implementation has to remember.
   */
  roles(subject: string): Promise<readonly string[]> | readonly string[]
  /** What each role grants. A role nothing maps to grants nothing. */
  table: Record<string, readonly Grant[]>
  /** The role a caller with no session has. Defaults to `anonymous`. */
  anonymous?: string
}

export function roleGrants(options: RoleGrantOptions): GrantSource {
  for (const [role, grants] of Object.entries(options.table)) assertUsable(grants, `role '${role}'`)
  const anonymous = options.anonymous ?? 'anonymous'

  return async (ctx) => {
    // Through the context, so the read is recorded where every other read of the request is.
    const subject = await ctx.user()
    const roles = subject === null ? [anonymous] : await options.roles(subject)
    return {
      subject,
      capabilities: grantsOf([...roles], options.table),
      via: roles.join(','),
    }
  }
}
