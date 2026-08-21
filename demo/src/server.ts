import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import {
  createRouter,
  createKernel,
  leaseCoalescer,
  type Kernel,
  type RouteEntry,
  type RouteResolver,
} from '../../packages/kernel/src/index.ts'
import {
  channelHandlers,
  memoryStore,
  nodeTransport,
  cookieSession,
  staticFlags,
} from '../../packages/adapters/src/index.ts'
import { STYLE } from './style.ts'
import { coverageBody, indexBody } from './index-page.ts'
import { page, type PageMeta } from './pages.ts'
import { showcaseRoutes } from './showcases.ts'
import { HANDLERS } from './stations/index.ts'
import { BY_ID, STATIONS } from './stations.ts'
import { channel, type DemoChannel } from './channel.ts'
import { lanesFrom, race } from './race.ts'
import { budgets, deltas, versions } from './api.ts'

/**
 * One hub for the whole process. Two browser tabs on the feed are two connections on one hub
 * holding the same base render, which is the only arrangement in which the shared-delta claim is
 * observable rather than asserted.
 */
let hubOnce: Promise<DemoChannel> | null = null
function sharedChannel(): Promise<DemoChannel> {
  hubOnce ??= channel(store)
  return hubOnce
}

/**
 * The demo, served by the framework it demonstrates.
 *
 * Every page here goes through `kernel.serve` — the index, the coverage page and every station,
 * not only the showcases. That is the point: a demo whose own chrome is rendered by something else
 * is a demo that has quietly exempted itself from its own claims.
 *
 * There is no build step. Client modules are TypeScript with their types stripped by Node, so what
 * runs in the browser is the file in the repository, and a station that shows you source is showing
 * you the same bytes it is running.
 */
const RUNTIME = fileURLToPath(new URL('../../packages/client/src/', import.meta.url))
const WARP = fileURLToPath(new URL('../../packages/warp/src/', import.meta.url))
const DEMO_CLIENT = fileURLToPath(new URL('./client/', import.meta.url))

const store = memoryStore({ maxBytes: 32 * 1024 * 1024 })

async function module_(path: string): Promise<string> {
  return stripTypeScriptTypes(await readFile(path, 'utf8'), { mode: 'strip' })
}

function meta(path: string, id: string): PageMeta {
  const station = BY_ID[id]
  if (!station) throw new Error(`E_NO_STATION: ${id}`)
  return {
    path,
    title: station.title,
    heading: station.title,
    shows: station.shows,
    control: station.control,
    status: station.status,
  }
}

async function stationRoutes(): Promise<RouteEntry<RouteResolver>[]> {
  return Promise.all(
    STATIONS.map(async (station) => {
      const path = `/s/${station.id}`
      const handler = HANDLERS[station.id]
      // The handler runs inside the body slot, where a render context exists — so its controls
      // are `ctx.query()` reads rather than a URL parsed in the server, and a station reads its
      // own controls the way an application would.
      return {
        pattern: path,
        value: async () =>
          page(
            meta(path, station.id),
            handler
              ? {
                  body: async (ctx) => {
                    const parts = await handler(ctx)
                    return [
                      typeof parts.panel === 'function' ? await parts.panel(ctx) : (parts.panel ?? ''),
                      typeof parts.body === 'function' ? await parts.body(ctx) : (parts.body ?? ''),
                      typeof parts.readout === 'function' ? await parts.readout(ctx) : (parts.readout ?? ''),
                    ].join('\n')
                  },
                }
              : { body: notBuilt(station.id) },
          ),
      }
    }),
  )
}

function notBuilt(id: string): string {
  const station = BY_ID[id]
  const roadmap = station?.roadmap
  return `<div class="card"><h3>${station?.status === 'refused' ? 'Not built' : 'Page not written yet'}</h3>
    <p>${
      station?.status === 'refused'
        ? 'The capability does not exist. Rather than mock it, this page says so.'
        : 'The capability is built and measured; this page is not written yet. It is marked <code>planned</code> in the registry, and the registry is what the index reads — so this cannot quietly claim to be live.'
    }</p>
    <p class="hint">Covers ${station?.covers.map((c) => `<code>spec/${c}</code>`).join(', ')}${
      roadmap
        ? ` · <a href="https://github.com/raminjafary/weft/blob/main/ROADMAP.md#${roadmap}">roadmap</a>`
        : ''
    }</p></div>`
}

export interface Serving {
  url: string
  close(): Promise<void>
}

export async function serveDemo(port = 4173): Promise<Serving> {
  const showcases = await showcaseRoutes()
  const routes = createRouter<RouteResolver>([
    {
      pattern: '/',
      value: async () =>
        page(
          {
            path: '/',
            title: 'Every capability, running',
            heading: 'Every capability, running',
            shows:
              'A station per mechanism and a showcase per shape of page. If a capability is in the specs it has a station here, and a test fails the build when one is missing.',
            control:
              'Pick anything. Each page states what it is showing, what produced the number, and what the number does not cover.',
            status: 'live',
          },
          { body: indexBody() },
        ),
    },
    {
      pattern: '/spec',
      value: async () =>
        page(
          {
            path: '/spec',
            title: 'Coverage',
            heading: 'Spec coverage',
            shows: 'Every spec document, and the stations that claim to be its live version.',
            control: 'None. This page is a gate rendered as a table.',
            status: 'live',
          },
          { body: coverageBody() },
        ),
    },
    {
      // The live streaming race, framed by the streaming-order station. A route per request,
      // because the order and the three latencies are controls.
      pattern: '/live/race',
      value: async () => {
        const query = new URLSearchParams(lastQuery)
        const order = query.get('order') === 'in-order' ? 'in-order' : 'out-of-order'
        return race(order, lanesFrom(query))
      },
    },
    ...showcases,
    ...(await stationRoutes()),
  ])

  const hub = await sharedChannel()

  const kernelFor = (res: ServerResponse): Kernel =>
    createKernel({
      ports: {
        store,
        session: cookieSession({ cookie: 'sid' }),
        flags: staticFlags({ axes: { 'new-cart': ['off', 'on'] } }),
        executors: {},
        transport: nodeTransport(res),
      },
      coalesce: leaseCoalescer(store, { pollMs: 5 }),
      routes,
      notFound: () => new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } }),
      intents: (request) => hub.intents(request),
    })

  const channelRoute = channelHandlers({ hub: hub.hub, path: '/channel' })

  const server: Server = createServer((req, res) => {
    void handle(req, res, kernelFor, channelRoute)
  })
  server.on('upgrade', (req, socket, head) => {
    if (!channelRoute.upgrade(req, socket as never, head)) socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
  })

  // `localhost` rather than `127.0.0.1`: on macOS `localhost` resolves to ::1 first, and a server
  // bound only to the IPv4 loopback is a server the browser cannot reach at the address printed in
  // every tutorial.
  await new Promise<void>((resolve) => server.listen(port, 'localhost', resolve))
  const address = server.address()
  if (typeof address === 'string' || address === null) throw new Error('E_NO_ADDRESS')
  return {
    url: `http://localhost:${address.port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/**
 * The query of the request currently being routed.
 *
 * A `RouteResolver` receives path params only — deliberately, so a plan can be lowered once and
 * produce a route per request. The race route needs its controls before phase B exists, because
 * they decide how many slots there are and how long each one waits, and that is a shape a plan
 * cannot express today. Stated here rather than hidden: this is the one place in the demo that
 * reaches around the framework, and it is single-threaded so it is safe, not clever.
 */
let lastQuery = ''

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  kernelFor: (res: ServerResponse) => Kernel,
  channelRoute: ReturnType<typeof channelHandlers>,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
  const path = url.pathname
  lastQuery = url.search

  if (channelRoute.http(req, res)) return

  // The demo's own control endpoints. `tick` is the interesting one: it advances the feed once and
  // every open connection holding the invalidated key is told, from one store invalidation.
  if (path.startsWith('/api/')) {
    await api(path, req, res)
    return
  }

  if (path === '/demo.css') {
    res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' })
    res.end(STYLE)
    return
  }

  const served = await tryModule(path, res)
  if (served) return

  // A demo session, so the cart and the private fragments have somebody to be private for.
  if (!req.headers.cookie?.includes('sid=')) {
    res.setHeader(
      'set-cookie',
      `sid=demo-${Math.abs(hash(req.headers['user-agent'] ?? 'anon'))}; Path=/; SameSite=Lax`,
    )
  }

  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(key, value)
  }
  if (!headers.has('cookie'))
    headers.set('cookie', `sid=demo-${Math.abs(hash(req.headers['user-agent'] ?? 'anon'))}`)

  const body =
    req.method === 'GET' || req.method === 'HEAD'
      ? undefined
      : await new Response(Readable.toWeb(req) as never).arrayBuffer()

  const request = new Request(url, {
    method: req.method ?? 'GET',
    headers,
    ...(body ? { body } : {}),
  })

  // The router matches on path, so a station's controls reach its handler as a query string
  // carried through the matched params rather than as a second routing dimension.
  const kernel = kernelFor(res)
  const response = await kernel.serve(withQuery(request, url))

  const out: Record<string, string | string[]> = {}
  for (const [key, value] of response.headers) {
    out[key] = key === 'set-cookie' ? response.headers.getSetCookie() : value
  }
  const existing = res.getHeader('set-cookie')
  if (existing && !out['set-cookie']) out['set-cookie'] = existing as string
  res.writeHead(response.status, out)
  if (!response.body) {
    res.end()
    return
  }
  Readable.fromWeb(response.body as never).pipe(res)
}

/**
 * The query string, handed to a station handler through the route params.
 *
 * A station's controls are query parameters because the page is server-rendered: a slider that
 * changes what the server computed has to reach the server. Anything that must not round-trip is
 * client-side, and the station says which it is.
 */
function withQuery(request: Request, url: URL): Request {
  const next = new URL(request.url)
  next.search = url.search
  return new Request(next, request)
}

async function api(path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  const hub = await sharedChannel()
  switch (path) {
    case '/api/tick': {
      if (req.method !== 'POST') return json(405, { error: 'POST only: a tick is a mutation' })
      return json(200, await hub.tick())
    }
    case '/api/state':
      return json(200, { ...hub.state, channels: hub.hub.channels })
    case '/api/budgets':
      return json(200, await budgets())
    case '/api/deltas':
      return json(200, await deltas(200))
    case '/api/versions':
      return json(200, versions())
    default:
      return json(404, { error: `no endpoint ${path}` })
  }
}

async function tryModule(path: string, res: ServerResponse): Promise<boolean> {
  const roots: [string, string][] = [
    ['/runtime/', RUNTIME],
    ['/warp/', WARP],
    ['/demo/', DEMO_CLIENT],
  ]
  for (const [prefix, dir] of roots) {
    if (!path.startsWith(prefix)) continue
    try {
      const code = await module_(dir + path.slice(prefix.length))
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
      res.end(code)
    } catch {
      res.writeHead(404).end()
    }
    return true
  }
  return false
}

function hash(input: string): number {
  let h = 0
  for (let i = 0; i < input.length; i++) h = (Math.imul(h, 31) + input.charCodeAt(i)) | 0
  return h
}
