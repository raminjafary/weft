import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { access, readFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import {
  boundedDb,
  channelHandlers,
  cookieSession,
  envConfig,
  hostDeployment,
  irRenderer,
  memoryStore,
  nodeTransport,
  prioScheduler,
  staticFlags,
} from '@weft/adapters'
import {
  createEnvelope,
  createHub,
  createIntentDispatch,
  createIntentRouter,
  createKernel,
  createReads,
  createRouter,
  envelopeContext,
  leaseCoalescer,
  lifecycle,
  requestFacts,
  serveIntent,
  type ChannelHub,
  type Kernel,
  type Ports,
  type RenderContext,
  type RouteResolver,
  type SlotRender,
  type StorePort,
} from '@weft/kernel'
import {
  browserModule,
  buildAssets,
  cacheControlFor,
  weftAssets,
  type AssetTable,
  type ModuleTree,
} from './assets.ts'
import { setAssets, setCompiled, setPorts, setProfile } from './current.ts'
import { compileApp, frameworkStyles, type CompiledApp } from './compile.ts'
import { discover, type Discovered } from './convention.ts'
import { loadConfig, type ResolvedConfig, type WeftConfig } from './config.ts'
import { devtoolsFor } from './devtools.ts'
import { loadIntents, type IntentManifest } from './intents.ts'
import { services } from './context.ts'
import {
  createRecorder,
  decide,
  readProfile,
  writeProfile,
  type Decisions,
  type Recorder,
} from './profile.ts'
import { loadDocuments, type ServedDocument } from './static.ts'
import { generateRoutes, type GeneratedRoute } from './routes.ts'

/**
 * The application, served.
 *
 * Everything in this file is what an application would otherwise have had to write for itself: a
 * kernel with a ports record, a router, a channel hub with a slot source, an intent dispatch on
 * two bindings, module serving, asset revving and a stylesheet. None of it is
 * application-specific, which is exactly the reason none of it should ever have been in an
 * application.
 *
 * There is no bundler. Client modules are TypeScript served with their types stripped, so what
 * runs in the browser is the file on disk — before a build and after one. Both paths are the same
 * code, which is the only arrangement in which the second one can be trusted.
 */
/**
 * `dev` serves from source at stable URLs that must never cache. `build` compiles and revs.
 * `start` serves the build's sealed templates and its revved URLs, and runs no compiler.
 */
export type Mode = 'dev' | 'build' | 'start'

export interface App {
  config: ResolvedConfig
  discovered: Discovered
  compiled: CompiledApp
  intents: IntentManifest
  routes: GeneratedRoute[]
  store: StorePort
  hub: ChannelHub
  /**
   * What each open channel is: which page, and whose session.
   *
   * A channel has no request, so the client says where it is when it opens one and a refresh
   * re-runs that route. The cookie header comes from the channel's own connection, because an
   * intent that ran without the session the page has is an intent writing somebody else's cart.
   */
  at: Map<string, Connection>
  assets: AssetTable
  /**
   * L0. Documents the build resolved and proved invariant, by the path each one answers.
   *
   * Populated by `weft start` and empty everywhere else: `weft dev` serving a file it rendered
   * before your last edit is a dev server that lies to you, and the build is where a document
   * becomes a file in the first place.
   */
  documents: Map<string, ServedDocument>
  diagnostics: string[]
  mode: Mode
  /**
   * What this process is recording, and what the last recording decided.
   *
   * Both null unless `profile` is on. The recorder is what every slot render reports to; the
   * decisions are what the plan was generated *from*, so `weft why` can attribute a delivery to a
   * measurement rather than to a declaration nobody wrote.
   */
  recorder: Recorder | null
  decided: Decisions | null
  /**
   * What this deployment bound, built once and shared by every path that needs ports.
   *
   * Four of these used to be constructed per request — a session, a flag source, an executor
   * table and a store reference, rebuilt for the kernel, for the intent dispatch and for the
   * channel. Three copies of the same decisions is three places to change one of them.
   */
  ports: Ports
  /** The live-slot keys a set of write tags reaches, for a notify that has to name keys. */
  keysFor(tags: readonly string[]): string[]
}

export interface Connection {
  /** The path the client was on when it opened the channel, params and query included. */
  path: string
  /** The channel connection's own cookie header, verbatim. */
  cookie: string
}

export interface Serving {
  url: string
  app: App
  close(): Promise<void>
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Where a package's servable source lives.
 *
 * `import.meta.resolve` answers with the built entry, which is right for a deployment and wrong
 * inside this repository before anything has been built. Falling back to `src` rather than
 * failing means `weft dev` works on a fresh clone, and the bytes served are still that package's
 * own — just the ones with types still in them.
 */
async function packageTree(specifier: string): Promise<ModuleTree> {
  const resolved = fileURLToPath(import.meta.resolve(specifier))
  if (await exists(resolved)) return { dir: dirname(resolved), ext: '.js' }
  const source = resolved.replace(/([\\/])dist([\\/])/, '$1src$2').replace(/\.js$/, '.ts')
  if (await exists(source)) return { dir: dirname(source), ext: '.ts' }
  throw new Error(`E_NO_PACKAGE: no servable source for ${specifier} at ${resolved} or ${source}`)
}

export interface CreateOptions extends WeftConfig {
  mode?: Mode
  /** Supplied by `weft start`, which reads sealed templates instead of running the compiler. */
  compiled?: CompiledApp
}

export async function createApp(root: string, options: CreateOptions = {}): Promise<App> {
  const { mode = 'dev', compiled: prebuilt, ...overrides } = options
  const config = await loadConfig(root, overrides)
  const discovered = await discover(root, config.srcDir)
  const compiled = prebuilt ?? (await compileApp(discovered, { outDir: config.outDir, types: config.types }))
  // Published before the route modules are imported, because a station page's loader reads the
  // compiled IR and its module is evaluated during generation.
  setCompiled(compiled)
  const intents = await loadIntents(root, discovered.intents)
  const store = config.store ?? memoryStore({ maxBytes: 64 * 1024 * 1024 })

  // A fragment's colocated stylesheet, by the file the compiler named it with and by the
  // absolute path the convention found it at — the two disagree, and both are asked.
  const styleOf = (() => {
    const table = new Map<string, string>()
    const put = (file: string | undefined, css: string | undefined): void => {
      if (file && css) table.set(file, css)
    }
    put(discovered.layout, discovered.layoutCss)
    for (const route of discovered.routes) put(route.file, route.css)
    for (const slot of discovered.slots) put(slot.file, slot.css)
    for (const fragment of discovered.fragments) put(fragment.file, fragment.css)
    const byRelative = new Map([...table].map(([file, css]) => [relative(root, file), css]))
    return (file: string): string | undefined => table.get(file) ?? byRelative.get(file)
  })()

  // The asset table cannot be built until the generator has said which stylesheets each route
  // uses, and the generator needs hrefs. So the hrefs are resolved when a page renders, by
  // which time the table exists — one late binding rather than an unrevved URL.
  let assets: AssetTable | null = null
  const table = (): AssetTable => {
    if (!assets) throw new Error('E_ASSETS_NOT_BUILT')
    return assets
  }

  /**
   * Every port this deployment binds, in one place.
   *
   * Thirteen are declared and this binds ten of them. The three that are not here are bound per
   * request because they are per request: the transport is a `ServerResponse`, and the registry
   * and the executor table belong to the intent dispatch and the config respectively.
   *
   * `assets` takes the table lazily. The hrefs carry a digest of the bundle's contents and the
   * bundle is not assembled until the generator has said which stylesheets each page links, so at
   * this point there is no table yet — one late binding rather than a 103 pointing at a URL that
   * will not exist.
   */
  const configPort = config.config ?? envConfig()
  const ports: Ports = {
    store,
    session: cookieSession({ cookie: config.session.cookie }),
    flags: staticFlags({ axes: config.flags }),
    executors: config.executors,
    scheduler: prioScheduler({ maxConcurrency: config.maxConcurrency }),
    assets: weftAssets(table),
    render: irRenderer(),
    config: configPort,
    deployment:
      config.deployment ??
      hostDeployment({ config: configPort, ...(mode === 'dev' ? { environment: 'development' } : {}) }),
    db: config.db ?? boundedDb(config.telemetry ? { telemetry: config.telemetry } : {}),
    ...(config.telemetry ? { telemetry: config.telemetry } : {}),
  }
  // Published before the route modules render: a station page's loader may read what this
  // deployment bound, and a page about the ports is a page about *these* ports.
  setPorts(ports)

  /**
   * The last recording, and what it decided.
   *
   * Read before the plan is generated because it is an input to it: delivery comes from the
   * profile where there is one and from the declaration where there is not. A profile from a
   * different format version is ignored rather than half-read.
   */
  const recorded = config.profile ? await readProfile(root, config.outDir) : null
  const decided = recorded ? decide(recorded) : null
  const recorder = config.profile ? createRecorder() : null
  setProfile(recorded && decided ? { profile: recorded, decisions: decided } : null)
  const { routes } = await generateRoutes({
    discovered,
    compiled,
    config,
    ports,
    styleHref: (pattern) => table().pageCss(pattern),
    ...(decided ? { profile: decided } : {}),
    ...(recorder ? { recorder } : {}),
    styleOf,
    store,
    runtime: () => table().boot,
    brand: basename(root) || 'weft',
  })

  // The cascade, per page: the framework's stylesheet, the application's, anything the config
  // added, and then the `.css` beside every fragment this page renders. One bundle, so a page
  // links the styles of the components on it without paying a request per component.
  const shared: string[] = [`/* weft */\n${await frameworkStyles()}`]
  if (discovered.styles) {
    shared.push(`/* ${config.srcDir}/styles.css */\n${await readFile(discovered.styles, 'utf8')}`)
  }
  for (const file of config.css) {
    shared.push(`/* ${file} */\n${await readFile(join(root, file), 'utf8')}`)
  }
  const pageCss = new Map<string, string>()
  for (const route of routes) {
    const parts = [...shared]
    for (const file of route.css) {
      parts.push(`/* ${relative(root, file)} */\n${await readFile(file, 'utf8')}`)
    }
    pageCss.set(route.pattern, parts.join('\n\n'))
  }

  assets = await buildAssets({
    pageCss,
    publicDir: join(root, 'public'),
    client: await ownTree(),
    runtime: await packageTree('@weft/client'),
    warp: await packageTree('@weft/warp'),
    ...(discovered.client ? { app: { dir: dirname(discovered.client), ext: '.ts' as const } } : {}),
    // Dev must never cache: a stylesheet you just edited, served as immutable, is a framework
    // that lies to you for a year.
    revved: mode !== 'dev',
  })
  setAssets(assets)

  const at = new Map<string, Connection>()
  // Which live slots carry which tag. A connection is recorded as holding the key its slot
  // source returned, so an invalidation can only reach it if something names that key — and the
  // store's tag index cannot, because a live slot's key is the framework's, not an entry it wrote.
  const keysByTag = new Map<string, Set<string>>()
  for (const route of routes) {
    for (const live of Object.values(route.live)) {
      for (const tag of live.tags) {
        const set = keysByTag.get(tag) ?? new Set<string>()
        set.add(live.key)
        keysByTag.set(tag, set)
      }
    }
  }
  const keysFor = (tags: readonly string[]): string[] => [
    ...new Set(tags.flatMap((tag) => [...(keysByTag.get(tag) ?? [])])),
  ]

  const dispatch = createIntentDispatch({ registry: intents.registry, store })
  const hub = createHub({
    store,
    source: liveSource(routes, at, ports),
    /**
     * The real dispatch, with the framework's own live keys folded into what it dropped.
     *
     * The hub turns `outcome.dropped` into STALE frames for every other connection, and it gets
     * that list from the store. A live slot's key is not a store entry, so without this an
     * intent would refresh the tab that fired it and silently leave every other tab showing
     * stale values — which looks exactly like not having push invalidation at all.
     */
    intents: {
      run: async (id, raw, ctx) => {
        const outcome = await dispatch.run(id, raw, ctx)
        if (!outcome.ok) return outcome
        const extra = keysFor(outcome.invalidated)
        return { ...outcome, dropped: [...new Set([...outcome.dropped, ...extra])] }
      },
    },
    /**
     * The context an intent runs against, built from the channel's own connection.
     *
     * A channel is not a request, so this has to be supplied — and what it has to carry is the
     * session, or an intent dispatched over the channel writes as nobody. The cookie header is
     * the connection's, recorded when it opened.
     */
    intentContext: (channel) => {
      const life = lifecycle()
      const envelope = createEnvelope(life)
      life.to('envelope')
      const connection = at.get(channel.id)
      const headers = new Headers()
      if (connection?.cookie) headers.set('cookie', connection.cookie)
      const url = new URL(connection?.path ?? config.channelPath, 'http://weft.local')
      return envelopeContext(createReads(requestFacts(new Request(url, { headers })), ports), envelope)
    },
    templates: (version) => compiled.templates.find((t) => t.version === version),
  })

  return {
    config,
    discovered,
    compiled,
    intents,
    routes,
    store,
    hub,
    at,
    assets,
    documents: mode === 'start' ? await loadDocuments(config) : new Map(),
    diagnostics: compiled.diagnostics,
    mode,
    ports,
    recorder,
    decided,
    keysFor,
  }
}

async function ownTree(): Promise<ModuleTree> {
  const dir = fileURLToPath(new URL('./client/', import.meta.url))
  return { dir, ext: (await exists(join(dir, 'boot.js'))) ? '.js' : '.ts' }
}

/**
 * The channel's slot source, generated.
 *
 * A channel has no request, so the client says which page it is on when it opens one. That path
 * is matched against the same route table the document went through and the slot's own loader is
 * re-run — so a refresh over the channel and a fresh document request compute the same thing
 * from the same code. Without that the delta could not be trusted to describe the page it is
 * patching.
 */
function liveSource(
  routes: GeneratedRoute[],
  at: Map<string, Connection>,
  ports: Ports,
): (request: { slot: string; channel: { id: string } }) => Promise<SlotRender | null> {
  const router = createRouter(routes.map((route) => ({ pattern: route.pattern, value: route })))
  return async ({ slot, channel }) => {
    const connection = at.get(channel.id)
    if (!connection) return null
    const url = new URL(connection.path, 'http://weft.local')
    const matched = router.match(url)
    if (!matched) return null
    const live = matched.value.live[slot]
    if (!live) return null
    const ctx = channelContext(url, matched.params, connection.cookie, ports)
    const values = await live.load(ctx, matched.params)
    return { ir: live.fragment.entry, values, resolve: live.fragment.resolve, key: live.key, prefer: 'delta' }
  }
}

/**
 * The read surface a channel refresh runs against.
 *
 * There is no envelope, because a refresh has no response to write to — so a deferred effect has
 * nowhere to go and is dropped rather than queued against a request that ended long ago.
 */
function channelContext(
  url: URL,
  params: Record<string, string>,
  cookie: string,
  ports: Ports,
): RenderContext {
  const headers = new Headers()
  if (cookie) headers.set('cookie', cookie)
  const reads = createReads(requestFacts(new Request(url, { headers }), params), ports)
  // The same services a document render hands a loader: a slot refreshed over the channel runs
  // the same code, and a context that differed between the two would make the delta describe a
  // render nobody could reproduce.
  return { ...reads, ...services(ports), phase: 'render', defer: () => {} }
}

export async function serveApp(app: App): Promise<Serving> {
  const { assets, at, config, documents, intents, keysFor, recorder, routes, store, hub } = app
  const table = createRouter<RouteResolver>(routes.map((route) => route.entry))

  const http = serveIntent({
    registry: intents.registry,
    store,
    routes: createIntentRouter(intents.routes),
    ports: app.ports,
    returnTo: (request) => request.headers.get('referer') ?? '/',
  })

  /**
   * A write over plain HTTP still has to tell the open channels.
   *
   * The channel binding gets this for free: its dispatch lives inside the hub. A form post does
   * not, and an invalidation that notified nobody is the same bug as having no push invalidation
   * at all.
   */
  const dispatchOverHttp = async (request: Request): Promise<Response> => {
    const response = await http.handle(request)
    if (response.status >= 400) return response
    const tags = [...new Set(intents.entries.flatMap((entry) => entry.writes))]
    if (tags.length) await hub.invalidate(tags, 'a form post wrote it')
    const keys = keysFor(tags)
    if (keys.length) await hub.notify(keys, 'a form post wrote it')
    return response
  }

  const channel = channelHandlers({ hub, path: config.channelPath })
  // Null unless `devtools: true`, and a named refusal outside `weft dev`. Off, it is one null
  // check per request and nothing else — no route, no template, no asset.
  const devtools = devtoolsFor(app)
  const firstCss = routes[0] ? assets.pageCss(routes[0].pattern) : ''

  // What the client needs before it can do anything, and the only two things it cannot derive.
  const prelude =
    `window.__weftIntents = ${JSON.stringify(intents.names)};\n` +
    `window.__weftChannel = ${JSON.stringify(config.channelPath)};\n` +
    `window.__weftScroll = ${JSON.stringify(config.scroll)};\n` +
    (assets.app ? `window.__weftClient = ${JSON.stringify(assets.app)};\n` : '')

  // The deployment's ports, plus the one that is a property of this response rather than of the
  // deployment: 103 goes out on a socket, so the transport is per request and nothing else is.
  const kernelFor = (res: ServerResponse): Kernel =>
    createKernel({
      ports: { ...app.ports, transport: nodeTransport(res) },
      coalesce: leaseCoalescer(store, { pollMs: 5 }),
      routes: table,
      notFound: () =>
        // Styled with whatever the first route links, because a 404 is not a route and has no
        // bundle of its own. An application with no routes at all gets an unstyled one.
        new Response(
          notFound(
            routes.map((r) => r.pattern),
            firstCss,
          ),
          {
            status: 404,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          },
        ),
      intents: dispatchOverHttp,
    })

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.end()
        return
      }
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`${(error as Error).stack ?? String(error)}\n`)
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? config.host}`)
    const path = url.pathname

    // A channel open carries the page it belongs to and, on its own connection, the session it
    // belongs to. Both are needed later, when there is no request to ask.
    remember(url, req.headers.cookie)
    if (channel.http(req, res)) return
    if (devtools && (await devtools(req, res))) return

    /**
     * L0, and the whole of what it costs at serve time.
     *
     * The document was rendered at build time and proved not to depend on the request, so
     * everything below this line — key derivation, the plan, the wave scheduler, the store, the
     * stream — is work with a known answer. A conditional request costs the digest comparison and
     * nothing else. Only `weft start` populates the table, so this is a no-op in dev.
     */
    const document = req.method === 'GET' || req.method === 'HEAD' ? documents.get(path) : undefined
    if (document) {
      const headers = { ...document.headers, etag: document.etag, 'x-weft-tier': 'l0' }
      if (req.headers['if-none-match'] === document.etag) {
        res.writeHead(304, headers)
        res.end()
        return
      }
      res.writeHead(200, { ...headers, 'content-length': String(document.body.byteLength) })
      res.end(req.method === 'HEAD' ? undefined : document.body)
      return
    }

    const file = assets.files.get(path)
    if (file) {
      res.writeHead(200, { 'content-type': file.type, 'cache-control': cacheControlFor(file) })
      res.end(typeof file.body === 'string' ? file.body : Buffer.from(file.body))
      return
    }

    for (const [prefix, tree] of assets.trees) {
      if (!path.startsWith(prefix)) continue
      const name = path.slice(prefix.length)
      if (!name || name.includes('..') || name.includes('/')) {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('no\n')
        return
      }
      const source = join(tree.dir, name)
      if (!(await exists(source))) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end(`no such module: ${name}\n`)
        return
      }
      const body = browserModule(await readFile(source, 'utf8'), tree, prefix, assets.trees)
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        // The tree's digest is in the path, so every file under it is immutable together.
        'cache-control': assets.revved ? 'public, max-age=31536000, immutable' : 'no-store',
      })
      res.end(path === assets.boot ? prelude + body : body)
      return
    }

    const headers = new Headers()
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(key, value)
      else if (Array.isArray(value)) for (const v of value) headers.append(key, v)
    }
    const body =
      req.method === 'GET' || req.method === 'HEAD'
        ? undefined
        : await new Response(Readable.toWeb(req) as never).arrayBuffer()

    /**
     * The request, recorded before it is served.
     *
     * The route comes from the same matcher the kernel is about to use, and where the reader came
     * from is the `Referer` matched against the same table — which is the only way to learn a
     * transition without asking the client to report one. A staged navigation sends a referer too,
     * so a page reached by a swap counts the same as a page reached by a load.
     */
    if (recorder && (req.method === 'GET' || req.method === 'HEAD')) {
      const matched = table.match(url)
      if (matched) {
        const referer = req.headers.referer
        const from = referer ? patternOf(referer) : undefined
        recorder.request(matched.pattern, from)
      }
    }

    const kernel = kernelFor(res)
    const response = await kernel.serve(
      new Request(url, { method: req.method ?? 'GET', headers, ...(body ? { body } : {}) }),
    )

    /**
     * Which slots the store answered for.
     *
     * A hit is the absence of a render, so it cannot be counted where renders are counted. The
     * trace names both — the key each slot resolved to, and the keys that hit — so the difference
     * is available for exactly as long as the request is, and a hit rate per slot is what says
     * whether a slow region is slow for readers or only slow the first time.
     */
    if (recorder && kernel.trace?.matched) {
      const hit = new Set(kernel.trace.hits)
      for (const [slot, resolved] of Object.entries(kernel.trace.keys)) {
        if (resolved.key && hit.has(resolved.key)) recorder.hit(kernel.trace.matched.pattern, slot)
      }
    }

    const out: Record<string, string | string[]> = {}
    for (const [key, value] of response.headers) {
      out[key] = key === 'set-cookie' ? response.headers.getSetCookie() : value
    }
    // Which build answered. One header, on every document, because the alternative is a deploy
    // log and a guess — and during a rollout the two versions are the whole question.
    if (app.ports.deployment) out['x-weft-revision'] = app.ports.deployment.revision
    res.writeHead(response.status, out)
    if (!response.body) {
      res.end()
      return
    }

    /**
     * A body that fails mid-stream has to end the response.
     *
     * By the time a slot throws, the status line and the headers are long gone — so there is no
     * status code left to say it with, and the only honest signal is a truncated body. What is
     * *not* honest is leaving the socket open: the browser then waits forever on a request that
     * has already failed, which is the one outcome indistinguishable from a hung server.
     *
     * `onExceed: 'fail'` is the policy that reaches this deliberately. It is supposed to fail the
     * response; it is not supposed to hang it.
     */
    const out_ = Readable.fromWeb(response.body as never)
    out_.on('error', (error: Error) => {
      process.stderr.write(`  slot failed mid-stream on ${path}: ${error.message}\n`)
      res.destroy()
    })
    out_.pipe(res)
  }

  /**
   * The recording, written as it is collected.
   *
   * Every thirty seconds rather than on exit, because the interesting case for a profile is a
   * process that was killed: a deployment that only ever wrote its numbers on a clean shutdown
   * would have nothing to show for the afternoon it spent falling over. Unref'd, so it cannot be
   * the reason a process stays alive.
   */
  const flushing = recorder
    ? setInterval(() => {
        void writeProfile(config.root, config.outDir, recorder.profile())
      }, 30_000)
    : null
  flushing?.unref()

  /**
   * Which route a URL belongs to, or nothing.
   *
   * A referer is a URL and a route is a pattern, so `/app/ordinary/pantry` and
   * `/app/ordinary/:category` are never equal — the same mistake the nav's current-page marking
   * made once. Matching with the router means one notion of "this URL is that page", and a referer
   * from another origin belongs to no pattern here and is dropped rather than counted as one.
   */
  function patternOf(href: string): string | undefined {
    try {
      const target = new URL(href)
      const matched = table.match(target)
      return matched?.pattern
    } catch {
      return undefined
    }
  }

  function remember(url: URL, cookie: string | undefined): void {
    const id = url.searchParams.get('c')
    const path = url.searchParams.get('at')
    if (!id) return
    const existing = at.get(id)
    at.set(id, {
      path: path ?? existing?.path ?? '/',
      cookie: cookie ?? existing?.cookie ?? '',
    })
  }

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? config.host}`)
    remember(url, req.headers.cookie)
    if (!channel.upgrade(req, socket as never, head)) socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
  })

  // `localhost` rather than `127.0.0.1`: on macOS `localhost` resolves to ::1 first, and a server
  // bound only to the IPv4 loopback is one the browser cannot reach at the address printed in
  // every tutorial.
  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve))
  const address = server.address()
  if (typeof address === 'string' || address === null) throw new Error('E_NO_ADDRESS')

  return {
    url: `http://${config.host}:${address.port}/`,
    app,
    close: async () => {
      if (flushing) clearInterval(flushing)
      // Written on the way out as well as periodically: the last thirty seconds of a run are
      // exactly the ones a `weft profile` after a load test wants to include.
      if (recorder) await writeProfile(config.root, config.outDir, recorder.profile())
      await new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
    },
  }
}

function notFound(patterns: readonly string[], css: string): string {
  const links = `<link rel="stylesheet" href="${css}">`
  const list = patterns.map((p) => `<li><a href="${p}"><code>${p}</code></a></li>`).join('')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>404</title>${links}</head>
  <body><main class="weft-main"><h1>404</h1>
  <p class="weft-lede">No route matches this path. The route table is the file tree, so this list is
  every page that exists.</p><ul>${list}</ul></main></body></html>`
}
