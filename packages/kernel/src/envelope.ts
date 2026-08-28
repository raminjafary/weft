import type { Lifecycle } from './request.ts'
import { serializeCookie, type SetCookie } from './ports.ts'

/**
 * The response envelope, and the two phases HTTP forces on it: phase A owns it, phase B streams
 * with a context that has no envelope methods on it at all, so the mistake cannot be written. See
 * `spec/kernel/lifecycle.md`.
 */
export class EnvelopeError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(`${code} — ${message}`)
    this.name = 'EnvelopeError'
    this.code = code
  }
}

/** What can wait for the next response when this one's envelope is already sealed. */
export type DeferrableKind = 'cookie' | 'header'

/** An effect that missed its window. Only idempotent, refreshable writes qualify. `required()` is the only door for consent. */
export interface DeferredEffect {
  kind: DeferrableKind
  cookie?: SetCookie
  header?: { name: string; value: string }
  reason: string
}

/** The response head, and the fact that it seals: a status, a cookie, a redirect, `Vary` — possible in phase A, impossible after. */
export interface Envelope {
  status(code: number): void
  redirect(location: string, code?: number): void
  /** Ends the request in phase A with no body. A separate act from `status()`, or a guard and an error page would be indistinguishable. */
  refuse(code: number): void
  header(name: string, value: string): void
  /** Sets a default without overwriting what phase A already decided. */
  headerIfUnset(name: string, value: string): void
  setCookie(cookie: SetCookie): void
  cacheControl(value: string): void
  vary(header: string): void
  /** Phase A only. A write that must land on this response or the request is wrong. */
  required(write: () => void): void
  /** Legal in phase B. Queued for the next request on this connection, or dropped if there is none — why only idempotent effects qualify. */
  deferrable(effect: DeferredEffect): void
  seal(): ResponseInit
  readonly sealed: boolean
  readonly deferred: readonly DeferredEffect[]
  readonly redirected: string | null
  readonly refused: boolean
}

const NON_IDEMPOTENT = /consent|purchase|order|payment|csrf|nonce/i

/** An envelope bound to one request's lifecycle, so a late write is a named refusal. */
export function createEnvelope(life: Lifecycle): Envelope {
  const headers = new Headers()
  const cookies: SetCookie[] = []
  const deferred: DeferredEffect[] = []
  const vary = new Set<string>()
  let status = 200
  let redirected: string | null = null
  let refused = false
  let sealed = false

  const openOnly = (what: string): void => {
    if (sealed) throw new EnvelopeError('E_ENVELOPE_SEALED', `${what} after the first flush`)
    life.mustBe(['received', 'envelope'], what, 'E_ENVELOPE_SEALED')
  }

  return {
    get sealed() {
      return sealed
    },
    get deferred() {
      return deferred
    },
    get redirected() {
      return redirected
    },
    get refused() {
      return refused
    },
    status(code) {
      openOnly('status()')
      status = code
    },
    redirect(location, code = 302) {
      openOnly('redirect()')
      status = code
      redirected = location
      headers.set('location', location)
    },
    refuse(code) {
      openOnly('refuse()')
      status = code
      refused = true
    },
    header(name, value) {
      openOnly(`header(${name})`)
      headers.set(name, value)
    },
    headerIfUnset(name, value) {
      openOnly(`header(${name})`)
      if (!headers.has(name)) headers.set(name, value)
    },
    setCookie(cookie) {
      openOnly(`setCookie(${cookie.name})`)
      cookies.push(cookie)
    },
    cacheControl(value) {
      openOnly('cacheControl()')
      headers.set('cache-control', value)
    },
    vary(header) {
      openOnly('vary()')
      vary.add(header)
    },
    required(write) {
      life.mustBe(['received', 'envelope'], 'envelope.required()', 'E_ENVELOPE_REQUIRED_LATE')
      write()
    },
    deferrable(effect) {
      if (effect.kind === 'cookie') {
        const c = effect.cookie
        if (!c) throw new EnvelopeError('E_NOT_DEFERRABLE', 'a cookie effect with no cookie')
        if (NON_IDEMPOTENT.test(c.name) || NON_IDEMPOTENT.test(effect.reason)) {
          throw new EnvelopeError(
            'E_NOT_DEFERRABLE',
            `${c.name} is not idempotent, so it cannot be attached to a later response. Move it to phase A`,
          )
        }
      }
      deferred.push(effect)
    },
    seal() {
      if (sealed) throw new EnvelopeError('E_ENVELOPE_SEALED', 'seal() twice')
      sealed = true
      if (vary.size) headers.set('vary', [...vary].sort().join(', '))
      for (const cookie of cookies) headers.append('set-cookie', serializeCookie(cookie))
      return { status, headers }
    },
  }
}

/** Where a deferred effect waits. Keyed by connection; bounded, so an effect nobody comes back for does not accumulate. */
export interface DeferredMailbox {
  owe(connection: string, effects: readonly DeferredEffect[]): void
  claim(connection: string): DeferredEffect[]
  readonly size: number
}

/** Where a deferred cookie or header waits for a connection's next response. Bounded on purpose. */
export function createMailbox(maxConnections = 1024): DeferredMailbox {
  const pending = new Map<string, DeferredEffect[]>()
  return {
    get size() {
      return pending.size
    },
    owe(connection, effects) {
      if (!effects.length) return
      const existing = pending.get(connection)
      if (existing) {
        existing.push(...effects)
      } else {
        if (pending.size >= maxConnections) {
          // Oldest first — a documented outcome, not a leak.
          const oldest = pending.keys().next().value
          if (oldest !== undefined) pending.delete(oldest)
        }
        pending.set(connection, [...effects])
      }
    },
    claim(connection) {
      const effects = pending.get(connection) ?? []
      pending.delete(connection)
      return effects
    },
  }
}

/** Applied at the top of phase A, which is the only place they can still be real headers. */
export function applyDeferred(envelope: Envelope, effects: readonly DeferredEffect[]): number {
  let applied = 0
  for (const effect of effects) {
    if (effect.kind === 'cookie' && effect.cookie) {
      envelope.setCookie(effect.cookie)
      applied++
    } else if (effect.kind === 'header' && effect.header) {
      envelope.header(effect.header.name, effect.header.value)
      applied++
    }
  }
  return applied
}
