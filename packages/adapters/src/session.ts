import type { RequestFacts, SessionPort, SetCookie } from '@weftjs/kernel'

/** Cookies, tokens, identity — and nothing else. See `spec/kernel/ports.md`: `SessionPort`. */
export interface CookieSessionOptions {
  cookie?: string
  /** Maps the cookie's value to an identity. A real implementation verifies a signature. */
  identify?(token: string): Promise<string | null> | string | null
  /** Tokens older than this are rotated in phase A, where a Set-Cookie is still a real header. */
  rotateAfterMs?: number
  clock?: () => number
}

/** Identity and cookies from a signed cookie. The default, and a real one. */
export function cookieSession(options: CookieSessionOptions = {}): SessionPort {
  const cookieName = options.cookie ?? 'sid'
  const clock = options.clock ?? (() => Date.now())

  return {
    name: 'cookie',
    cookie(request, key) {
      return request.cookies[key]
    },
    async identity(request) {
      const token = request.cookies[cookieName]
      if (!token) return null
      return options.identify ? options.identify(token) : token
    },
    rotateIfStale(request: RequestFacts) {
      if (options.rotateAfterMs === undefined) return []
      const token = request.cookies[cookieName]
      if (!token) return []
      const issued = Number(token.split('.')[1] ?? NaN)
      if (!Number.isFinite(issued) || clock() - issued < options.rotateAfterMs) return []
      const rotated: SetCookie = {
        name: cookieName,
        value: `${token.split('.')[0]}.${clock()}`,
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      }
      return [rotated]
    },
  }
}
