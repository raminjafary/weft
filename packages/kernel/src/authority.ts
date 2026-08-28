import type { EnvelopeContext } from './context.ts'
import type { CapabilityCheck } from './intent.ts'
import type { TelemetryPort } from './ports.ts'

/**
 * Who may run an intent, implemented rather than declared. A caller holds a set of grants, an
 * intent names the capabilities it requires, and the dispatch runs only when every one is held —
 * deny by default and on failure, every capability required rather than any, `*` refused at
 * construction. See `spec/kernel/authority.md`.
 */

/** A capability a caller holds. Either exact (`cart:write`) or a namespace (`cart:*`). */
export type Grant = string

/** What a caller holds, as the grant source answered. */
export interface Grants {
  /** Who this is, for the audit line. Null for a caller with no session. */
  subject: string | null
  capabilities: readonly Grant[]
  /** Where the grants came from — a role name, a token, a table. For the audit line, never the wire. */
  via?: string
}

/** Where a caller's grants come from. An `EnvelopeContext`: reading identity through it taints `identity`. */
export type GrantSource = (ctx: EnvelopeContext) => Promise<Grants> | Grants

/** Whether the call is allowed, what it needed, what it held, and what was missing. */
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

/** Where grants come from, and what every caller holds without asking. */
export interface CapabilityOptions {
  grants: GrantSource
  /** Grants every caller holds, session or not. Where a public capability goes. */
  ambient?: readonly Grant[]
  /** Every decision, allowed and denied both — a log of denials only hides a successful escalation as silence. */
  audit?(decision: Decision): void
  telemetry?: TelemetryPort
}

/** An authority refusal, carrying the code so the HTTP status can be derived from it. */
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
 * The grants a set of role names amounts to. Exported because the closed-set check needs it — a
 * capability nothing can grant is an intent permanently 403 with nothing saying why.
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

/** Answers whether a caller may run an intent. An unchecked capability is refused, not allowed. */
export interface CapabilityModel {
  /** The `CapabilityCheck` the intent dispatch takes. */
  readonly check: CapabilityCheck
  /** The same decision, with the reasons on it. What an audit page and a test read. */
  decide(ctx: EnvelopeContext, capabilities: readonly string[]): Promise<Decision>
  /** Decisions taken, newest last, capped. For devtools; never for a policy decision. */
  recent(): readonly Decision[]
}

const RECENT = 50

/** A model over a grant source. A source that is down is a refusal about the source, not the subject. */
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
      // An identity service that is down is not a caller who is allowed: the refusal is about the
      // source, not the subject.
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
 * Grants from the session's identity, through a role table — the smallest thing that is a real
 * model. Anonymous is a subject of `null` with the `anonymous` role, a row an operator can edit.
 */
export interface RoleGrantOptions {
  /**
   * What a subject's roles are. An unknown subject has none — a denial, not an error. Never called
   * with a null subject: that caller has the anonymous role.
   */
  roles(subject: string): Promise<readonly string[]> | readonly string[]
  /** What each role grants. A role nothing maps to grants nothing. */
  table: Record<string, readonly Grant[]>
  /** The role a caller with no session has. Defaults to `anonymous`. */
  anonymous?: string
}

/** Grants by role, which is the smallest source that is not a stub. */
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
