import { createReads, envelopeContext } from './context.ts'
import { createEnvelope } from './envelope.ts'
import {
  createIntentDispatch,
  IntentError,
  type IntentDispatchOptions,
  type IntentOutcome,
} from './intent.ts'
import { requestFacts, type Ports } from './ports.ts'
import { lifecycle } from './request.ts'
import { createRouter, type RouteEntry, type Router } from './router.ts'

/**
 * A mutation over plain HTTP, which is the part that has to work with no JavaScript at all.
 *
 * A form posts to a path, the intent runs, and the response is a 303 back to where the form
 * was. That is the whole progressive-enhancement story and it is why the intent path is
 * method-aware routing rather than only a channel frame: a client with a working socket takes
 * the fast path, and a client with none takes the one browsers have always had.
 *
 * `fetch` gets the same dispatch and an ACK-shaped JSON body instead of a redirect, chosen by
 * `Accept` rather than by a separate endpoint — one dispatch, two representations.
 */
export interface IntentRoute {
  method: string
  /** `/cart`, `/product/:sku`. The same pattern language the document router uses. */
  pattern: string
  /** The opaque id the compiler derived for the intent's module and export. */
  intent: string
}

export interface IntentRouter {
  match(method: string, url: URL | string): { intent: string; params: Record<string, string> } | null
  readonly routes: readonly IntentRoute[]
}

export function createIntentRouter(routes: readonly IntentRoute[]): IntentRouter {
  const byMethod = new Map<string, Router<string>>()
  const grouped = new Map<string, RouteEntry<string>[]>()
  for (const route of routes) {
    const method = route.method.toUpperCase()
    if (method === 'GET' || method === 'HEAD') {
      throw new IntentError(
        'E_INTENT_ON_SAFE_METHOD',
        route.intent,
        `${method} ${route.pattern}: a safe method cannot carry a mutation, and a GET that writes is the oldest bug in the web`,
      )
    }
    const list = grouped.get(method) ?? []
    list.push({ pattern: route.pattern, value: route.intent })
    grouped.set(method, list)
  }
  for (const [method, entries] of grouped) byMethod.set(method, createRouter(entries))

  return {
    routes: [...routes],
    match(method, url) {
      const matched = byMethod.get(method.toUpperCase())?.match(url)
      return matched ? { intent: matched.value, params: matched.params } : null
    },
  }
}

export interface ServeIntentOptions extends IntentDispatchOptions {
  routes: IntentRouter
  clock?: () => number
  ports: Ports
  /** Where a form post goes when the intent did not redirect. Defaults to the Referer, then `/`. */
  returnTo?(request: Request): string
}

export interface IntentServer {
  handle(request: Request): Promise<Response>
  readonly last: IntentOutcome | null
}

export function serveIntent(options: ServeIntentOptions): IntentServer {
  const dispatch = createIntentDispatch(options)
  let last: IntentOutcome | null = null

  return {
    get last() {
      return last
    },
    async handle(request) {
      const url = new URL(request.url)
      const matched = options.routes.match(request.method, url)
      if (!matched) {
        return new Response(null, { status: 404 })
      }

      const life = lifecycle()
      const envelope = createEnvelope(life)
      life.to('envelope')
      const facts = requestFacts(request, matched.params)
      const reads = createReads(facts, options.ports, options.clock ? { clock: options.clock } : {})
      const base = envelopeContext(reads, envelope)

      let raw: unknown
      try {
        raw = await payload(request)
      } catch (error) {
        return json(422, { ok: false, code: 'E_INTENT_PAYLOAD', detail: String(error) })
      }

      const outcome = await dispatch.run(matched.intent, raw, base)
      last = outcome

      // The envelope is still open, so a real status, a real Set-Cookie and a redirect a
      // crawler will follow are all still available. This is the moment they exist in.
      if (!outcome.ok) envelope.status(statusFor(outcome.code))
      const wantsHtml = (request.headers.get('accept') ?? '').includes('text/html')
      if (outcome.ok && wantsHtml && !envelope.redirected) {
        envelope.redirect(options.returnTo?.(request) ?? request.headers.get('referer') ?? '/', 303)
      }
      const init = envelope.seal()
      life.to('settled')

      if (envelope.redirected || envelope.refused) return new Response(null, init)
      return new Response(JSON.stringify(bodyOf(outcome)), {
        ...init,
        headers: [...new Headers(init.headers), ['content-type', 'application/json']],
      })
    },
  }
}

function bodyOf(outcome: IntentOutcome): Record<string, unknown> {
  return {
    ok: outcome.ok,
    ...(outcome.code ? { code: outcome.code, detail: outcome.detail } : {}),
    invalidated: outcome.invalidated,
    refresh: outcome.refresh,
    ...(outcome.data !== undefined ? { data: outcome.data } : {}),
  }
}

/** Named refusals map to the status that describes them, rather than everything being a 500. */
function statusFor(code: string | undefined): number {
  switch (code) {
    case 'E_NO_SUCH_INTENT':
      return 404
    case 'E_CAPABILITY_DENIED':
      return 403
    case 'E_NO_CAPABILITY_CHECK':
      return 501
    case 'E_INTENT_INPUT':
      return 422
    case 'E_UNDECLARED_WRITE':
      return 500
    default:
      return 500
  }
}

async function payload(request: Request): Promise<unknown> {
  const type = request.headers.get('content-type') ?? ''
  if (type.includes('application/json')) return request.json()
  if (type.includes('form-urlencoded') || type.includes('multipart/form-data')) {
    return Object.fromEntries(await request.formData())
  }
  const text = await request.text()
  return text.length ? text : {}
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
