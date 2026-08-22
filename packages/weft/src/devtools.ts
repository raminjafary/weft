import type { IncomingMessage, ServerResponse } from 'node:http'
import { cookieSession, staticFlags } from '@weft/adapters'
import type { Ports } from '@weft/kernel'
import { document_, refusal, section } from './devtools/html.ts'
import { DevtoolsError } from './devtools/report.ts'
import { bytesPage, fragments, intents, overview, routes, why } from './devtools/pages.ts'
import type { App } from './serve.ts'

/**
 * `weft routes` and `weft why` as pages, plus the byte report, pointed at your application.
 *
 * This is one framework-owned URL prefix reading the `App` object this process is already
 * holding. There is no second compile, no second fragment table, no prefixed patterns and no
 * merged intent manifest — all of which is what mounting a demonstration application inside a
 * real one would have cost, for the payoff of a URL prefix on somebody else's fixtures.
 *
 * Three properties are deliberate.
 *
 * It is **dev only, and says so rather than pretending**. `devtools: true` under `weft start`
 * is refused by name: a deployment serving its own route table, every effect set and the
 * reason behind every cache key is not a smaller version of a development convenience, it is a
 * different thing. Under `weft build` nothing here is registered at all, because a build never
 * calls `serveApp`.
 *
 * It **costs the framework's measured paths nothing**. Nothing in this file is reachable from
 * the kernel; `serveApp` holds one nullable handler, and when devtools is off that is a single
 * null check on a path that was already doing a string compare per request. No template is
 * compiled, no asset is added to the table, and no byte of this reaches a page.
 *
 * It **refuses rather than approximates**. A route it does not have, a page it does not serve,
 * and a key it cannot resolve because the pattern's params were not supplied are each an
 * `E_`-coded refusal that names the fix, not a blank cell that looks like an answer.
 */
export const DEVTOOLS_PATH = '/_weft/devtools'

/** Handled or not, in the shape `serveApp` already uses for the channel. */
export type DevtoolsHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>

/**
 * The four bindings a key resolves against, which have to be the kernel's or the answer would
 * be an answer to a different question. `identity` comes from the session port and a flag axis
 * from the flag port, so a devtools page that built either of them differently would print a
 * key the kernel would never compute.
 */
function portsFor(app: App): Ports {
  return {
    store: app.store,
    session: cookieSession({ cookie: app.config.session.cookie }),
    flags: staticFlags({ axes: app.config.flags }),
    executors: app.config.executors,
  }
}

function headersOf(req: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(key, value)
    else if (Array.isArray(value)) for (const each of value) headers.append(key, each)
  }
  return headers
}

async function render(app: App, url: URL, headers: Headers): Promise<string> {
  const page = url.pathname.slice(DEVTOOLS_PATH.length).replace(/^\//, '')
  if (page === '') return document_(overview(app, DEVTOOLS_PATH))
  if (page === 'routes') return document_(routes(app, DEVTOOLS_PATH))
  if (page === 'fragments') return document_(fragments(app, DEVTOOLS_PATH))
  if (page === 'intents') return document_(intents(app, DEVTOOLS_PATH))
  if (page === 'bytes') return document_(await bytesPage(app, DEVTOOLS_PATH))
  if (page === 'why') {
    return document_(await why(app, DEVTOOLS_PATH, url.searchParams, headers, portsFor(app)))
  }
  throw new DevtoolsError(
    'E_NO_SUCH_PAGE',
    `devtools has no page called '${page}'. It has: routes, why, fragments, intents, bytes`,
  )
}

/**
 * Devtools for this application, or nothing.
 *
 * Returning `null` rather than a handler that declines is the whole of the "no cost" claim:
 * with devtools off there is no closure to call and nothing to match against.
 */
export function devtoolsFor(app: App): DevtoolsHandler | null {
  if (!app.config.devtools) return null
  if (app.mode !== 'dev') {
    throw new Error(
      `E_DEVTOOLS_NOT_DEV: devtools: true is set and this is \`weft ${app.mode}\`. Devtools serves ` +
        `the route table, every effect set and the reason behind every cache key, which is not ` +
        `something a deployment should answer. Remove devtools from ${app.config.file ?? 'weft.config.ts'}.`,
    )
  }

  return async (req, res) => {
    const path = (req.url ?? '/').split('?')[0] as string
    if (path !== DEVTOOLS_PATH && !path.startsWith(`${DEVTOOLS_PATH}/`)) return false
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? app.config.host}`)

    let status = 200
    let body: string
    try {
      body = await render(app, url, headersOf(req))
    } catch (error) {
      if (!(error instanceof DevtoolsError)) throw error
      status = 404
      body = document_({
        current: '',
        title: 'refused',
        subtitle: 'devtools names what it cannot do rather than approximating it',
        root: DEVTOOLS_PATH,
        body: section('refused', refusal(error.code, error.message.replace(/^E_[A-Z_]+ — /, ''))),
      })
    }

    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      // Never stored, and never indexed. These pages describe a process that is still running.
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
    })
    res.end(body)
    return true
  }
}

export { DevtoolsError } from './devtools/report.ts'
export type { ByteReport, FragmentReport, RouteReport, WhyPage } from './devtools/report.ts'
export { byteReport, fragmentReport, paramsOf, routeReport, whyPage } from './devtools/report.ts'
