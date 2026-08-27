import type { RequestFacts, SessionPort, SetCookie } from '@weftjs/kernel'

/**
 * Cookies, tokens, identity — and nothing else. The whole reason this is swappable without
 * consequence is that caching does not depend on it: a cache key comes from the effect
 * signature, so changing where identity comes from cannot change cacheability. That is what
 * "set a cookie without worrying" means here; it is a consequence, not a slogan.
 */
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
