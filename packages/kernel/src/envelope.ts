import type { Lifecycle } from './request.ts'
import { serializeCookie, type SetCookie } from './ports.ts'

/**
 * The response envelope, and the two phases HTTP forces on it.
 *
 * Status and headers precede the body, so the moment the first body byte is flushed the
 * envelope is sealed. Every framework picks a side of that trade-off and writes it in the
 * docs. Here the lifecycle splits instead: phase A owns the envelope and is cheap by
 * nature — session, locale, flag bucket, auth — and phase B streams with a context that
 * has no envelope methods on it at all, so the mistake cannot be written.
 *
 * What is irreducibly lost after the seal is stated rather than worked around: a real
 * status code, an HttpOnly cookie, `Cache-Control`, `Vary`, and a redirect a crawler will
 * follow. Anything needing those belongs in phase A, and the kernel's job is to force it
 * there rather than let it be discovered in production.
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

/**
 * An effect that missed its window. Only idempotent, refreshable writes qualify — token
 * rotation, a preference cookie, a last-seen timestamp. Recording consent does not, and
 * `required()` is the only door for it.
 */
export interface DeferredEffect {
  kind: DeferrableKind
  cookie?: SetCookie
  header?: { name: string; value: string }
  reason: string
}

/**
 * The response head, and the fact that it seals.
 *
 * Everything here is possible in phase A and impossible afterwards: a status, a cookie, a redirect,
 * `Vary`. The machine's job is to force that work before the first byte rather than let it be
 * discovered in production.
 */
export interface Envelope {
  status(code: number): void
  redirect(location: string, code?: number): void
  /**
   * Ends the request in phase A with no body. `status()` only sets a code — a route is
   * entitled to serve a 404 page — so refusing has to be a separate act, or a guard and an
   * error page would be indistinguishable to the kernel.
   */
  refuse(code: number): void
  header(name: string, value: string): void
  /** Sets a default without overwriting what phase A already decided. */
  headerIfUnset(name: string, value: string): void
  setCookie(cookie: SetCookie): void
  cacheControl(value: string): void
  vary(header: string): void
  /** Phase A only. A write that must land on this response or the request is wrong. */
  required(write: () => void): void
  /**
   * Legal in phase B. Queued for the next request on this connection, which for an
   * interactive app is milliseconds away and is a real HTTP response, so HttpOnly and
   * Secure work normally. If there is no next request the effect is dropped — which is
   * exactly why only idempotent effects qualify.
   */
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

/**
 * Where a deferred effect waits. Keyed by connection, because that is the scope in which
 * "the next request" is a meaningful phrase — and it is bounded, because an effect nobody
 * ever comes back for must not accumulate.
 */
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
          // Oldest first. A dropped deferred effect is a documented outcome, not a leak.
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
