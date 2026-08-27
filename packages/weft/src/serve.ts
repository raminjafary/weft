import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { access, readFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { patchPayload, render } from '@weft/ir'
import { entityTag, matchesTag } from './entity.ts'
import { isScopedSheet, scopeAttribute, scopeCss, scopeStem } from './scoped.ts'
import { frame, str, type Frame } from '@weft/warp'
import {
  boundedDb,
  channelHandlers,
  cookieSession,
  countingLimits,
  envConfig,
  hostDeployment,
  irRenderer,
  memoryStore,
  nodeTransport,
  prioScheduler,
  staticFlags,
} from '@weft/adapters'
import {
  channelRegions,
  createComposer,
  readsFor,
  createEnvelope,
  createHub,
  createIntentDispatch,
  createIntentRouter,
  createKernel,
  createRenderDispatch,
  createReads,
  createRouter,
  createExtender,
  createStager,
  envelopeContext,
  leaseCoalescer,
  lifecycle,
  requestFacts,
  serveIntent,
  type ChannelHub,
  type DiscoveredRoute,
  type Kernel,
  type ChannelRegions,
  type Ports,
  type RenderContext,
  type RouteResolver,
  type SlotFrames,
  type SlotRender,
  type EnvelopeContext,
  type RegionSpec,
  type SlotRequest,
  type StorePort,
} from '@weft/kernel'
import { verifyRegions, type VerifyReport } from '@weft/plan'
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
import { resolveAuthority, serveToken, TOKEN_PATH, type Authority } from './authority.ts'
import { serveStale, STALE_PATH } from './stale.ts'
import { loadIntents, moduleIdOf, type IntentManifest } from './intents.ts'
import { loadCatalogue, type Catalogue } from './renderables.ts'
import { regionRegistry } from './regions.ts'
import { services } from './context.ts'
import {
  createRecorder,
  decide,
  likelyNext,
  readProfile,
  writeProfile,
  type Decisions,
  type Recorder,
} from './profile.ts'
import { loadDocuments, type ServedDocument } from './static.ts'
import { generateRoutes, type GeneratedRoute } from './routes.ts'
import { createSpeculation } from './speculate.ts'

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

/** A built application: its routes, its ports, its hub, and everything a page can ask about itself. */
export interface App {
  config: ResolvedConfig
  discovered: Discovered
  compiled: CompiledApp
  intents: IntentManifest
  /**
   * The catalogue: fragments a client may ask for by opaque id, generated from `app/renderables/`.
   *
   * Empty for an application with no such directory, which is most of them — and empty means the
   * registry answers no renderable at all, so a client naming one is `E_NO_SUCH_RENDERABLE` rather
   * than reaching something that happened to be compiled.
   */
  catalogue: Catalogue
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
  /**
   * What this deployment resolved about its own regions, or null for one that composes none.
   *
   * Run at startup rather than at build time because none of it is knowable at build time: a
   * registry is a deployment's and can be written to without anybody rebuilding. What is here is the
   * half that needs no network — a name nothing resolves, a tier nobody bound, a plan and a registry
   * that disagree about whether a boundary is crossed. The half that needs one is `weft verify`.
   */
  regions: VerifyReport | null
  /**
   * Everything a reader should be told before the first request rather than by a 501 in front of
   * somebody. Authority's refusals, and a region nothing can resolve.
   */
  warnings: string[]
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
  /**
   * Re-derive every connection's exposed shell values and tell whoever's changed.
   *
   * On the app rather than inside the hub because both intent bindings have to call it, and the
   * channel's dispatch is the only one the hub can see. A form post that left every open page's
   * exposed values stale would be push invalidation working on one binding out of two.
   */
  republishExposed(except?: string): Promise<void>
  /**
   * Who may run an intent here, and which intents need a token this deployment minted.
   *
   * Resolved once and shared by both bindings on purpose: a capability enforced over the channel
   * and not over the POST path would be a capability with a documented way around it.
   */
  authority: Authority
}

/** One channel's server-side state: where it is, and what it was told it holds. */
export interface Connection {
  /** The path the client was on when it opened the channel, params and query included. */
  path: string
  /** The channel connection's own cookie header, verbatim. */
  cookie: string
  /**
   * Routes this connection has been *told about*, by pattern.
   *
   * Held so a description can be scored. A client asks to stage a route it has not been to only
   * because it was described one — a client with no description does not know the shell matches — so
   * a `WARM at=` for a pattern in this set is a description that paid, and one for a pattern outside
   * it is a hover on a link the page had anyway.
   */
  described?: Set<string>
}

/** A running application: the URL it answers on, and how to stop it. */
export interface Serving {
  url: string
  app: App
  close(): Promise<void>
}

const utf8 = new TextEncoder()

/**
 * Which frame kinds change what the reader sees. The same set `region-channel.ts` uses, and the same
 * reason: everything else is what a client needs in order to apply one of these, so it travels
 * immediately even inside an epoch.
 */
const PAINTS = new Set<Frame['kind']>(['HTML', 'DELTA', 'DATA', 'PATCH'])

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

/** Config overrides, plus whether to compile or to load a build. */
export interface CreateOptions extends WeftConfig {
  mode?: Mode
  /** Supplied by `weft start`, which reads sealed templates instead of running the compiler. */
  compiled?: CompiledApp
}

/** A folder into an application: discover, compile, generate, bind, and wire the channel. */
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

  // A fragment's colocated stylesheets, by the file the compiler named it with and by the absolute
  // path the convention found it at — the two disagree, and both are asked. Global first, scoped
  // after, which is the order that lets a component take the shared look and then differ from it.
  const styleOf = (() => {
    const table = new Map<string, string[]>()
    const put = (file: string | undefined, ...sheets: (string | undefined)[]): void => {
      const found = sheets.filter((sheet): sheet is string => Boolean(sheet))
      if (file && found.length) table.set(file, found)
    }
    put(discovered.layout, discovered.layoutCss, discovered.layoutScopedCss)
    for (const layout of discovered.nested) put(layout.file, layout.css, layout.scopedCss)
    for (const route of discovered.routes) put(route.file, route.css, route.scopedCss)
    for (const slot of discovered.slots) put(slot.file, slot.css, slot.scopedCss)
    for (const fragment of discovered.fragments) put(fragment.file, fragment.css, fragment.scopedCss)
    const byRelative = new Map([...table].map(([file, css]) => [relative(root, file), css]))
    return (file: string): readonly string[] => table.get(file) ?? byRelative.get(file) ?? []
  })()

  // The asset table cannot be built until the generator has said which stylesheets each route
  // uses, and the generator needs hrefs. So the hrefs are resolved when a page renders, by
  // which time the table exists — one late binding rather than an unrevved URL.
  let assets: AssetTable | null = null
  const table = (): AssetTable => {
    if (!assets) {
      throw new Error(
        'E_ASSETS_NOT_BUILT: an asset href was asked for before the bundle existed. Hrefs carry a ' +
          'digest of the bundle, so the table is built after the generator says which stylesheets ' +
          'each page links — this call happened before that',
      )
    }
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
  /**
   * The limiter, from whichever half the config supplied.
   *
   * A config that supplies `counted` is supplying the only decision a framework cannot make, and
   * the counting is then the framework's — over the store above, which is the store everything else
   * on this deployment already shares. A config that supplies a whole port owns both, which is what
   * a gateway or a platform limiter is.
   */
  const limits =
    config.limits && 'check' in config.limits
      ? config.limits
      : config.limits
        ? countingLimits({ store, counted: config.limits.counted })
        : undefined

  const configPort = config.config ?? envConfig()
  /**
   * The registry, bound once and for both of its jobs.
   *
   * `ports.registry` used to be the one declared port nothing here bound, on the grounds that the
   * intent dispatch had its own and regions had no front door. Regions have one now, and a region
   * name has to resolve through a port rather than through a table compiled into the page that
   * composes it — otherwise rolling a region is a redeploy of every shell that names it, which is
   * the property the port exists to provide.
   */
  /**
   * The catalogue, resolved late for the same reason the asset table is.
   *
   * The registry answers renderables, the catalogue's region-served entries are composed through the
   * ports, and the ports carry the registry. One late binding rather than three constructors that
   * each want the other two — and it is a `let` in one file rather than an indirection anyone else
   * has to know about.
   */
  let catalogue: Catalogue = { entries: [], byId: new Map(), names: {} }
  const registry = regionRegistry(intents.registry, {
    regions: config.regions,
    ...(config.registry ? { registry: config.registry } : {}),
    renderable: (id) => catalogue.byId.get(id),
    renderables: () => [...catalogue.byId.keys()],
  })
  const ports: Ports = {
    store,
    registry,
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
    // Unbound on purpose. An intent that declares a limit is refused by name until a deployment
    // says what a call is counted against, because a kernel choosing would be guessing.
    ...(limits ? { limits } : {}),
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
  /**
   * A scoped sheet, narrowed once and reused by every page that links it.
   *
   * The rewrite is pure — one file, one attribute — so it is memoised by path rather than repeated
   * per route. On this site that is the difference between narrowing the contents rail's sheet once
   * and narrowing it twenty-three times.
   */
  const narrowed = new Map<string, string>()
  const sheet = async (file: string): Promise<string> => {
    const held = narrowed.get(file)
    if (held !== undefined) return held
    const body = await readFile(file, 'utf8')
    const text = isScopedSheet(file) ? scopeCss(body, scopeAttribute(relative(root, scopeStem(file)))) : body
    narrowed.set(file, text)
    return text
  }

  const pageCss = new Map<string, string>()
  for (const route of routes) {
    const parts = [...shared]
    for (const file of route.css) {
      parts.push(`/* ${relative(root, file)} */\n${await sheet(file)}`)
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

  /**
   * One region of one route, composed for a channel.
   *
   * Built per call rather than held, because a `Composer` accumulates the outcomes it produced — it
   * is what `composer.hops` counts — and one shared across every connection would be a page's hop
   * count growing forever.
   *
   * The same function answers a refresh and a stage, and the only difference is the request handed
   * in. That is deliberate: a region refreshed over the channel and the same region staged as part
   * of a route have to reach the same deployment with the same budget and the same contract, and a
   * second composition site is where those two would drift.
   */
  const composeRegion = (route: GeneratedRoute): ChannelRegions =>
    channelRegions({
      composer: createComposer({ ports }),
      regions: route.remote,
      route: () => route.pattern,
    })

  /**
   * The catalogue, built now that there is something to compose a region-served entry with.
   *
   * A renderable named by a region goes through the same composer a slot does — the same registry
   * resolution, the same arrival check, the same declared degradation — because "which deployment
   * renders this" is one question and it should not have two answers. What the entry supplies that a
   * slot does not is the params, which reach the region as an ordinary render request.
   */
  catalogue = await loadCatalogue({
    root,
    files: discovered.renderables,
    compiled,
    ports,
    moduleIdOf: (file) => moduleIdOf(root, file),
    compose: async (region, request) => {
      const spec: RegionSpec = { region, onExceed: 'placeholder' }
      const composer = createComposer({ ports })
      const outcome = await composer.compose(spec, {
        params: (request.params ?? {}) as Record<string, string>,
        ...(request.held ? { held: request.held } : {}),
        ...(request.epoch ? { epoch: request.epoch } : {}),
      })
      const also = outcome.frames.filter((f) => !PAINTS.has(f.kind))
      const paint =
        outcome.frames.find((f) => PAINTS.has(f.kind)) ??
        (outcome.bytes.length ? frame('HTML', { s: request.slot }, outcome.bytes, true) : undefined)
      return { ...(paint ? { paint } : {}), ...(also.length ? { also } : {}) }
    },
  })

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

  /**
   * Authority, resolved before anything can dispatch.
   *
   * `resolveAuthority` refuses here rather than at request time for the one failure a request
   * cannot explain: a capability an intent requires and no role grants. Everything else it finds
   * is a diagnostic, because the dispatch already refuses by name and a warning at startup is
   * where somebody can act on it.
   */
  /**
   * The region checks that need no network, run before the first request.
   *
   * A composed page that cannot resolve one of its regions fails at request time with a named
   * error, which is correct and late: the name is wrong in a config file, and the person who can
   * fix it is looking at a terminal. So the resolvable half is checked here and printed, and
   * `weft verify` is the same function with a probe and an exit code — a gate rather than a notice.
   */
  const composing = routes.map((route) => route.plan).filter((plan) => plan.slots.some((s) => s.region))
  const regionReport = composing.length
    ? await verifyRegions(composing, { registry, executors: Object.keys(config.executors) })
    : null

  const authority = await resolveAuthority(config.authority, intents, store, ports)
  const dispatch = createIntentDispatch({
    registry: intents.registry,
    store,
    ...(authority.model ? { capabilities: authority.model.check } : {}),
    ...(authority.verifier ? { verify: authority.verifier } : {}),
    ...(limits ? { limits } : {}),
  })

  /**
   * One route table, built once.
   *
   * Every path that has to turn a URL into a route — a document request, a refresh over the
   * channel, a route being staged, a plan being extended — was building its own. Four matchers
   * over one set of patterns is four chances for them to disagree about which route a URL is.
   */
  const router = createRouter(routes.map((route) => ({ pattern: route.pattern, value: route })))
  const routeAt = (path: string): ReturnType<typeof router.match> =>
    router.match(new URL(path, 'http://weft.local'))
  const here = (channel: { id: string }): ReturnType<typeof router.match> => {
    const connection = at.get(channel.id)
    return connection ? routeAt(connection.path) : null
  }
  const transitions = (): Record<string, string[]> => (recorded ? likelyNext(recorded) : {})

  /**
   * A route staged over the channel, which is `WARM at=` doing what the frame table always said.
   *
   * Two decisions live here because only this side can make them. Whether the target shares this
   * client's shell — a different document has different holes, so its regions cannot be swapped
   * into the ones on screen, and the honest answer then is a document request. And what each
   * region's next state is, which goes through the *same loaders* a document request would run:
   * a staged route that computed its values differently would be a page nobody could reproduce.
   */
  const stager = createStager({
    store,
    ...(config.telemetry ? { telemetry: config.telemetry } : {}),
    resolve: async ({ path, channel, epoch }) => {
      const target = routeAt(path)
      if (!target) return null
      const from = here(channel)
      if (!from || from.value.shell.version !== target.value.shell.version) {
        return {
          route: target.value.pattern,
          shared: false,
          why: from
            ? `${target.value.pattern} is rendered into a different document, whose holes are ${target.value.holes.join(', ')}`
            : 'this channel has not said which page it is on',
        }
      }

      const connection = at.get(channel.id)
      /**
       * A description that paid.
       *
       * Counted only when this connection was told about the target: a client asks to stage a route it
       * has not been to because it was described one — it has no other way to know the shell matches —
       * so a stage of a described pattern is the description being used. A stage of an undescribed one
       * is a hover on a link the page had anyway, and counting it would make every description look
       * successful.
       */
      if (connection?.described?.has(target.value.pattern)) recorder?.followed(target.value.pattern)
      const ctx = channelContext(
        new URL(path, 'http://weft.local'),
        target.params,
        connection?.cookie ?? '',
        ports,
      )
      const slots: Record<string, SlotRender | SlotFrames> = {}
      for (const [name, region] of Object.entries(target.value.regions)) {
        slots[name] = {
          ir: region.fragment.entry,
          values: await region.load(ctx, target.params),
          ...(region.fragment.resolve ? { resolve: region.fragment.resolve } : {}),
          key: region.key,
          prefer: 'delta',
        }
      }
      /**
       * The target's remote regions, composed as part of staging it.
       *
       * Without this a staged route arrived with its holes from other deployments empty, and the
       * reader saw a page assemble itself after the commit — which is the one thing staging exists to
       * prevent. Each region is told the epoch it is being staged into, so it knows the answer is not
       * going to paint yet and can decide its own frame split accordingly.
       */
      const compose = composeRegion(target.value)
      for (const [name, spec] of Object.entries(target.value.remote)) {
        // The region's declared reads, resolved through this channel's own context — the same
        // derivation a document request does, so a staged region renders against the values the page
        // it is being staged for would have rendered against.
        const reads = await readsFor(ctx, spec.contract)
        const frames = await compose({
          slot: name,
          channel,
          request: {
            route: target.value.pattern,
            params: target.params,
            ...(epoch ? { epoch } : {}),
            ...(reads ? { reads } : {}),
          },
        })
        if (frames) slots[name] = frames
      }
      const next = decided ? transitions()[target.value.pattern] : undefined
      return {
        route: target.value.pattern,
        shared: true,
        title: target.value.titleFor(target.params),
        css: table().pageCss(target.value.pattern),
        ...(next?.length ? { next } : {}),
        slots,
      }
    },
  })

  /**
   * The part of the plan a client does not have, described rather than rendered.
   *
   * Every field here is something a client would otherwise have to make a request to learn, and
   * the expensive one is the shell: a link whose target uses a different document cannot be swapped
   * in as regions, and finding that out by asking costs a round trip *and* a server render of a
   * page nobody clicked. Described, it costs a line in a frame the connection was already getting.
   *
   * Nothing here runs a loader. That is the difference between this and staging a route, and it is
   * why a page can afford to know about thirty routes and stage two.
   */
  const describe = (route: GeneratedRoute, shell: string | undefined, from?: string): DiscoveredRoute => {
    const next = decided ? transitions()[route.pattern] : undefined
    const versions = [...new Set(Object.values(route.regions).map((r) => r.fragment.entry.version))]
    const stage = worthStaging(route.pattern, from)
    return {
      pattern: route.pattern,
      shell: route.shell.version,
      shared: shell === route.shell.version,
      slots: Object.keys(route.regions),
      css: table().pageCss(route.pattern),
      ...(versions.length ? { tpl: versions } : {}),
      ...(next?.length ? { next } : {}),
      ...(stage === false ? { stage: false } : {}),
    }
  }

  /**
   * Whether staging this route from that page is worth the request.
   *
   * The last thing the profile measured and nobody read. `weft dev --profile` counts which route a
   * reader arrived from, `RouteDecision.stage` records the sources they arrive from often enough for
   * staging to pay, and until now that decision was printed by `weft profile` and then ignored —
   * every hovered link was fetched regardless, which is the guess the profile layer exists instead
   * of.
   *
   * Absent means unmeasured and unmeasured stages, the same rule delivery and discovery follow. And
   * a route with *no* recorded sources is unmeasured rather than refused: a page nobody has arrived
   * at yet has nothing to count, and inventing a `false` for it would turn a cold recording into a
   * framework that has switched staging off.
   */
  const worthStaging = (pattern: string, from?: string): boolean | undefined => {
    if (!decided || !from || from === pattern) return undefined
    const sources = decided.routes.find((r) => r.route === pattern)?.stage
    if (!sources?.length) return undefined
    return sources.includes(from)
  }

  /**
   * Whether a route is worth describing, from what the last recording saw.
   *
   * Absent from the decision means unmeasured, and unmeasured keeps the behaviour it had — the same
   * rule delivery follows, so a recording of last Tuesday cannot quietly turn discovery off for a
   * route it never saw.
   */
  const worthDescribing = (pattern: string): boolean =>
    decided?.discover.find((d) => d.route === pattern)?.describe ?? true

  /** A route described to this connection, recorded so the description can be scored later. */
  const noteDescribed = (channel: { id: string }, patterns: readonly string[]): void => {
    const connection = at.get(channel.id)
    if (connection) connection.described = new Set([...(connection.described ?? []), ...patterns])
    for (const pattern of patterns) recorder?.described(pattern)
  }

  const discovery = createExtender({
    ...(config.telemetry ? { telemetry: config.telemetry } : {}),
    resolve: ({ prefix, channel }) => {
      const from = here(channel)
      const shell = from?.value.shell.version
      /**
       * No prefix is the handshake, and what it answers is deliberately narrow: this page, and
       * where the profile says its readers go next. A connection opening is not a request to
       * describe the application — a route table pushed at every page load is a cost every reader
       * pays for a page most of them will not leave by a link.
       */
      if (prefix === undefined) {
        if (!from) return null
        // This page, always — it is where the connection is. Then where the profile says its readers
        // go, minus any the recording says are described and never followed.
        const patterns = [
          from.value.pattern,
          ...(transitions()[from.value.pattern] ?? []).filter(worthDescribing),
        ]
        const found = patterns
          .map((pattern) => routes.find((route) => route.pattern === pattern))
          .filter((route): route is GeneratedRoute => route !== undefined)
        noteDescribed(
          channel,
          found.map((route) => route.pattern),
        )
        return {
          prefix: from.value.pattern,
          routes: found.map((route) => describe(route, shell, from.value.pattern)),
        }
      }
      // `/checkout/*` and `/checkout` ask the same thing. The star is how the design spells it.
      const under = prefix.replace(/\/?\*$/, '')
      // A prefix somebody *asked* about is described whatever the recording says. The measurement is
      // about what this deployment volunteers, and a question is not a volunteer.
      const found = routes.filter((route) => route.pattern.startsWith(under))
      if (!found.length) return null
      noteDescribed(
        channel,
        found.map((route) => route.pattern),
      )
      return {
        prefix,
        routes: found.map((route) => describe(route, shell, from?.value.pattern)),
      }
    },
  })

  /**
   * What each connection was last told the shell exposes.
   *
   * Held so a change can be sent as a change. Recomputing the exposed set after a mutation and
   * sending all of it would work and would also send a `SIGNAL` for every name on every write, which
   * turns the one channel between a shell and its regions into a firehose the regions have to filter.
   */
  const exposedTo = new Map<string, Record<string, string>>()

  /**
   * The shell's declaration, as the frame that carries it.
   *
   * One frame with a body rather than one per name: this is the whole set at once, it is sent once
   * per connection, and a frame per name would be a frame per name. A `SIGNAL` with no `name` header
   * is the declaration; one with a name is a single value changing. The client tells them apart the
   * same way.
   */
  const declareExposed = async (channel: { id: string }): Promise<Frame[]> => {
    const from = here(channel)
    if (!from) return []
    const values = await from.value.exposed(from.params)
    if (!Object.keys(values).length) return []
    exposedTo.set(channel.id, values)
    return [frame('SIGNAL', {}, utf8.encode(JSON.stringify(values)), true)]
  }

  /**
   * Exposed values that changed, told to the connections showing them.
   *
   * A shell signal changes because something wrote what it is derived from, and the only thing here
   * allowed to write is an intent — so this runs after one, for the same reason a `STALE` does. What
   * it deliberately does not do is re-render anything: an exposed value is a shell value, the shell
   * is cheap, and a region decides for itself what a new value means for its own markup.
   */
  const republishExposed = async (except?: string): Promise<void> => {
    for (const [id, previous] of exposedTo) {
      if (id === except) continue
      const from = here({ id })
      if (!from) continue
      const values = await from.value.exposed(from.params)
      const changed = Object.entries(values).filter(([name, value]) => previous[name] !== value)
      if (!changed.length) continue
      exposedTo.set(id, values)
      // Through the channel rather than the hub: the hub's own broadcast is `notify`, which is about
      // cache keys, and a shell value is not one — nobody holds it as an entry.
      await hub.get(id)?.send(changed.map(([name, v]) => frame('SIGNAL', { name, v })))
    }
  }

  /**
   * The render-intent dispatch, sharing every gate with the intent one.
   *
   * The same capability check, the same verifier, the same limiter — bound from the same place, so a
   * capability enforced on a mutation and not on a render would be a capability with a documented way
   * around it. What this adds over the intent dispatch is the catalogue, and the catalogue is the
   * registry's.
   */
  const renders = createRenderDispatch({
    registry,
    ...(authority.model ? { capabilities: authority.model.check } : {}),
    ...(authority.verifier ? { verify: authority.verifier } : {}),
    ...(limits ? { limits } : {}),
  })

  const hub = createHub({
    store,
    /**
     * The second rung of the surgical ladder, bound because the front door is the deployment that
     * cannot know which shape its application's regions have. A page with a `raw()` value or an
     * isolated instance would otherwise have every refresh come back as markup.
     */
    patch: patchPayload,
    source: liveSource(routes, at, ports, composeRegion, {
      renders,
      names: catalogue.names,
      ports,
    }),
    /**
     * The real dispatch, with the framework's own live keys folded into what it dropped.
     *
     * The hub turns `outcome.dropped` into STALE frames for every other connection, and it gets
     * that list from the store. A live slot's key is not a store entry, so without this an
     * intent would refresh the tab that fired it and silently leave every other tab showing
     * stale values — which looks exactly like not having push invalidation at all.
     */
    intents: {
      run: async (id, raw, ctx, credentials) => {
        const outcome = await dispatch.run(id, raw, ctx, credentials)
        if (!outcome.ok) return outcome
        // A shell value a region reads may be derived from what this intent just wrote, and a region
        // has no other way to hear about it: the exposed set is the only channel there is.
        await republishExposed()
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
    warm: { at: stager, plan: discovery.warm },
    // The two things a connection is told without asking, in one place: the part of the plan it has
    // no way to know it is missing, and the shell values its regions are allowed to read.
    onOpen: async (channel) => [
      ...((await discovery.open(channel)) ?? []),
      ...(await declareExposed(channel)),
    ],
  })

  return {
    config,
    discovered,
    compiled,
    intents,
    catalogue,
    routes,
    store,
    hub,
    at,
    assets,
    documents: mode === 'start' ? await loadDocuments(config) : new Map(),
    // The compiler's, and only the compiler's: `weft build` prints this list under a heading that
    // says what it is, and folding a different kind of warning into it would make that heading lie.
    // Authority's warnings live on `authority.diagnostics` and are printed as their own.
    diagnostics: compiled.diagnostics,
    regions: regionReport,
    warnings: [
      ...authority.diagnostics,
      ...(regionReport?.errors ?? []).map(
        (issue) => `${issue.code}: region '${issue.slot}' — ${issue.message}. \`weft verify\` is the gate`,
      ),
    ],
    authority,
    mode,
    ports,
    recorder,
    decided,
    keysFor,
    republishExposed,
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
  composeRegion: (route: GeneratedRoute) => ChannelRegions,
  catalogue: {
    renders: ReturnType<typeof createRenderDispatch>
    /** Declared name to opaque id, so markup a person wrote can name an entry. */
    names: Record<string, string>
    ports: Ports
  },
): (request: SlotRequest) => Promise<SlotRender | SlotFrames | null> {
  const router = createRouter(routes.map((route) => ({ pattern: route.pattern, value: route })))
  return async ({ slot, channel, frame: asked }) => {
    const connection = at.get(channel.id)
    if (!connection) return null
    const url = new URL(connection.path, 'http://weft.local')
    const matched = router.match(url)
    if (!matched) return null
    const ctx = channelContext(url, matched.params, connection.cookie, ports)

    /**
     * A render intent: `REFRESH s=<slot> r=<id>`, which is the same question with a source named.
     *
     * Two checks live here rather than in the dispatch, because both are route knowledge and a
     * channel has none. The slot has to be a hole on the page this connection is showing — a
     * catalogue entry rendered into a slot that is not on the page is a frame the client refuses
     * anyway, and refusing it here says why. And the id may be the entry's declared name, because
     * markup a person wrote has to be able to name one; what travels on the wire is still the id.
     */
    const named = asked ? str(asked, 'r') : undefined
    if (named) {
      if (!matched.value.holes.includes(slot)) {
        return {
          also: [
            frame('ERROR', {
              code: 'E_NO_SUCH_SLOT',
              detail: `${matched.value.pattern} has no hole '${slot}'. Its holes are ${matched.value.holes.join(', ')}`,
            }),
          ],
        }
      }
      const outcome = await catalogue.renders.run(
        {
          id: catalogue.names[named] ?? named,
          slot,
          raw: asked?.body ? (JSON.parse(new TextDecoder().decode(asked.body)) as unknown) : {},
          ctx,
          ...(channel.held.get(slot) ? { held: [channel.held.get(slot)?.tpl as string] } : {}),
          ...(str(asked as Frame, 'epoch') ? { epoch: str(asked as Frame, 'epoch') as string } : {}),
        },
        // The gates run against an envelope context, because a capability check resolves a subject
        // and a verifier reads a token. The entry's own loader gets `ctx` above, which cannot write.
        renderContextFor(url, matched.params, connection.cookie, catalogue.ports),
      )
      if (outcome.ok) return outcome.source as SlotRender | SlotFrames
      return {
        also: [
          frame('ERROR', {
            code: outcome.code ?? 'E_RENDER_FAILED',
            detail: outcome.detail ?? '',
            s: slot,
          }),
        ],
      }
    }
    /**
     * A region on another deployment, refreshed.
     *
     * Asked before this route's own slots, because the two name spaces are the same one: a hole is
     * either filled from here or from somewhere else, never both — the plan layer refuses a remote
     * region with a local binding — so whichever answers first is the only one that can.
     *
     * There is no `live` gate on this branch, and that is not an oversight. `live` says "this
     * process may re-render the slot under a reader", which is a statement about a fragment this
     * process holds. A region's freshness is the region's own business; refusing to ask it would be
     * this deployment deciding something it has no view of.
     */
    const spec = matched.value.remote[slot]
    if (spec) {
      const reads = await readsFor(ctx, spec.contract)
      return composeRegion(matched.value)({
        slot,
        channel,
        request: { route: matched.value.pattern, params: matched.params, ...(reads ? { reads } : {}) },
      })
    }
    const live = matched.value.live[slot]
    if (!live) return null
    const values = await live.load(ctx, matched.params)
    return { ir: live.fragment.entry, values, resolve: live.fragment.resolve, key: live.key, prefer: 'delta' }
  }
}

/**
 * The envelope context a render intent's *gates* run against.
 *
 * A channel has no request, so this builds one from what the connection said — the same inputs
 * `channelContext` uses. It is an envelope context and not a render one because a capability check
 * resolves a subject and a verifier reads a token, and both of those are things a request that can
 * still be refused does. Nothing in it reaches the entry's own loader.
 */
function renderContextFor(
  url: URL,
  params: Record<string, string>,
  cookie: string,
  ports: Ports,
): EnvelopeContext {
  const life = lifecycle()
  const envelope = createEnvelope(life)
  life.to('envelope')
  const headers = new Headers()
  if (cookie) headers.set('cookie', cookie)
  return envelopeContext(createReads(requestFacts(new Request(url, { headers }), params), ports), envelope)
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

/** Put it on a port. Everything interesting already happened in `createApp`. */
export async function serveApp(app: App): Promise<Serving> {
  const { assets, at, authority, config, documents, intents, keysFor, recorder, routes, store, hub } = app
  const table = createRouter<RouteResolver>(routes.map((route) => route.entry))
  /**
   * Routes that answer a conditional request, by pattern.
   *
   * A set rather than a lookup into the route record, because this is consulted on the hot path for
   * every request and the answer is build-time knowledge: which routes declared that they would
   * rather be complete than early.
   */
  const conditional = new Set(routes.filter((route) => route.etag).map((route) => route.pattern))

  /**
   * `.speculate()`, after the response.
   *
   * A slot with a TTL has one request per period that pays for a render, and it is always
   * somebody's. This moves that render off a reader's request and onto time the process has already
   * finished charging — through the store's own after-response queue, which existed and was empty.
   */
  const speculation = createSpeculation({
    routes,
    store,
    ports: app.ports,
    onWarmed: (pattern, slot, ms) =>
      app.ports.telemetry?.measure('slot.speculated', ms, { route: pattern, slot }),
  })

  // The stylesheet a page the framework itself renders — a 404, a refused intent — links. There is
  // no bundle for a page that is not a route, so it borrows the first one's.
  const firstCss = routes[0] ? assets.pageCss(routes[0].pattern) : ''

  /**
   * The error page: `app/layouts/error.tsx` when the application wrote one, the framework's own
   * when it did not.
   *
   * A named layout rather than a special file, because that is what it is — a document, discovered
   * exactly the way every other document under `app/layouts/` is. Writing the file *is* the
   * registration, and `error` is the name the framework looks for.
   *
   * It is deliberately not a route. A 404 has no path of its own, and giving it one would make it a
   * page an application could link to — which is then a page that has to decide what to say when
   * nothing has gone wrong.
   *
   * The values below are the contract, and `src/assets/error.tsx` documents each one. A replacement
   * gets the same set: the status, the framework's own name for what happened, a sentence, the path
   * that was asked for, and the stack — which is empty outside `weft dev`, because a trace names
   * files and often the shape of the data being handled.
   */
  const errorFragment = app.compiled.fragments['layout:error'] ?? app.compiled.fragments.error
  const errorDecoder = new TextDecoder()

  function errorDocument(input: {
    status: number
    code: string
    title: string
    detail: string
    path?: string
    stack?: string
  }): string {
    const { status, code, title, detail, path = '', stack = '' } = input
    if (!errorFragment) {
      return `<!doctype html><meta charset="utf-8"><title>${escapeText(String(status))}</title>
        <h1>${escapeText(String(status))}</h1><p>${escapeText(detail)}</p>`
    }
    return errorDecoder.decode(
      render(
        errorFragment.entry,
        {
          title,
          description: detail,
          css: firstCss,
          status: String(status),
          code,
          detail,
          path,
          pathClass: path ? 'weft-error-subject' : 'weft-hidden',
          stack,
          stackClass: stack ? 'weft-error-stack' : 'weft-hidden',
          backHref: '/',
          backLabel: 'Go home',
        },
        errorFragment.resolve,
      ),
    )
  }

  const http = serveIntent({
    registry: intents.registry,
    store,
    routes: createIntentRouter(intents.routes),
    ports: app.ports,
    ...(app.authority.model ? { capabilities: app.authority.model.check } : {}),
    ...(app.authority.verifier ? { verify: app.authority.verifier } : {}),
    // Both bindings or neither. A limit enforced over the channel and not over the POST path is a
    // limit with a documented way around it, which is the same argument capabilities make.
    ...(app.ports.limits ? { limits: app.ports.limits } : {}),
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
    /**
     * A refused mutation, told to whoever asked.
     *
     * The dispatch answers with a named code and a reason, which is right, and until now the answer
     * a *browser* got for it was that JSON rendered as a page — the reader's document gone, replaced
     * by `{"ok":false,…}`. The no-JavaScript path is not finished at "the request was refused
     * correctly"; failing legibly is part of working.
     *
     * The framework's own fetch says so with a header and keeps the JSON, because it turns the same
     * refusal into a toast without leaving the page. A plain form post cannot send a header, which is
     * exactly the caller that needs the page.
     */
    if (response.status >= 400) {
      const wantsHtml = (request.headers.get('accept') ?? '').includes('text/html')
      if (!wantsHtml || request.headers.get('x-weft-fetch')) return response
      const said = (await response
        .clone()
        .json()
        .catch(() => null)) as { code?: string; detail?: string } | null
      return new Response(
        refusalPage(said?.code ?? `E_INTENT_${response.status}`, said?.detail ?? '', firstCss, request),
        {
          status: response.status,
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        },
      )
    }
    const tags = [...new Set(intents.entries.flatMap((entry) => entry.writes))]
    // Both bindings again: a form post that left every open page's exposed values stale would be the
    // channel binding quietly being the only one that works.
    await app.republishExposed()
    if (tags.length) await hub.invalidate(tags, 'a form post wrote it')
    const keys = keysFor(tags)
    if (keys.length) await hub.notify(keys, 'a form post wrote it')
    return response
  }

  const channel = channelHandlers({ hub, path: config.channelPath })
  // Null unless `devtools: true`, and a named refusal outside `weft dev`. Off, it is one null
  // check per request and nothing else — no route, no template, no asset.
  const devtools = devtoolsFor(app)

  // What the client needs before it can do anything, and the only two things it cannot derive.
  const prelude =
    `window.__weftIntents = ${JSON.stringify(intents.names)};\n` +
    `window.__weftChannel = ${JSON.stringify(config.channelPath)};\n` +
    (authority.signed.length ? `window.__weftSigned = ${JSON.stringify(authority.signed)};\n` : '') +
    `window.__weftScroll = ${JSON.stringify(config.scroll)};\n` +
    (assets.app ? `window.__weftClient = ${JSON.stringify(assets.app)};\n` : '')

  // The deployment's ports, plus the one that is a property of this response rather than of the
  // deployment: 103 goes out on a socket, so the transport is per request and nothing else is.
  const kernelFor = (res: ServerResponse): Kernel =>
    createKernel({
      ports: { ...app.ports, transport: nodeTransport(res) },
      coalesce: leaseCoalescer(store, { pollMs: 5 }),
      routes: table,
      notFound: (request) =>
        // Styled with whatever the first route links, because a 404 is not a route and has no
        // bundle of its own. An application with no routes at all gets an unstyled one.
        //
        // The path is named and the route table is not. That list was written for the person
        // building the application and shown to everyone who mistyped a URL — on a deployment it is
        // a map of the site handed to whoever asks for a path that does not exist. `weft routes`
        // prints it for the one audience it was for.
        new Response(
          errorDocument({
            status: 404,
            code: 'E_NO_ROUTE',
            title: 'This page does not exist',
            detail:
              'No route matches this path. It may have moved, or the link that brought you here may be out of date.',
            path: new URL(request.url).pathname,
          }),
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
      /**
       * A stack trace in development, a sentence in production.
       *
       * The trace is the only useful thing here while you are building, and the one thing that must
       * not go out otherwise: it names files, line numbers and often the shape of the data that was
       * being handled. `mode` already knows which of the two this process is.
       */
      /**
       * The trace in development, a sentence outside it.
       *
       * It is the only useful thing here while you are building, and the one thing that must not go
       * out otherwise: a stack names files, line numbers and often the shape of the data that was
       * being handled. In `weft dev` it is rendered into the page; anywhere else it is empty and the
       * block that would have held it is not drawn.
       */
      const stack = app.mode === 'dev' ? ((error as Error).stack ?? String(error)) : ''
      res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        errorDocument({
          status: 500,
          code: 'E_REQUEST_FAILED',
          title: 'Something went wrong',
          detail: 'This request could not be completed. Nothing you did caused it, and it has been recorded.',
          path: req.url ?? '',
          stack,
        }),
      )
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
      const body = typeof file.body === 'string' ? Buffer.from(file.body, 'utf8') : Buffer.from(file.body)
      const headers: Record<string, string> = {
        'content-type': file.type,
        'cache-control': cacheControlFor(file),
      }
      /**
       * A stable name is `no-cache`, which is a promise the client can only keep with a validator.
       *
       * A digest-bearing name needs none: its URL changes when its bytes do. A stable one carries
       * the tag instead, so `weft dev` answers a reload with 304 and no body rather than resending
       * a stylesheet the browser already has — which is what removed the unstyled frame on refresh.
       * Hashing on the way out costs a digest over bytes already in memory, against the alternative
       * of putting them all back on the wire.
       */
      if (!file.immutable) {
        const tag = await entityTag(new Uint8Array(body))
        headers.etag = tag
        if (matchesTag(req.headers['if-none-match'], tag)) {
          res.writeHead(304, headers)
          res.end()
          return
        }
      }
      res.writeHead(200, headers)
      res.end(body)
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
      const payload = path === assets.boot ? prelude + body : body
      const headers: Record<string, string> = {
        'content-type': 'text/javascript; charset=utf-8',
        // The tree's digest is in the path, so every file under it is immutable together.
        'cache-control': assets.revved ? 'public, max-age=31536000, immutable' : 'no-cache',
      }
      // Same bargain as the stylesheet above: in dev the path has no digest, so the tag is what
      // lets a reload cost 304 instead of the whole client runtime again.
      if (!assets.revved) {
        const tag = await entityTag(utf8.encode(payload))
        headers.etag = tag
        if (matchesTag(req.headers['if-none-match'], tag)) {
          res.writeHead(304, headers)
          res.end()
          return
        }
      }
      res.writeHead(200, headers)
      res.end(payload)
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
    const incoming = new Request(url, { method: req.method ?? 'GET', headers, ...(body ? { body } : {}) })

    /**
     * A token for a signed intent, minted for this reader and nothing else.
     *
     * Its own path rather than a field in a page, because a token in a render would be a token in
     * whatever cache holds that render. `serveToken` says the whole of why. POST because a token
     * has no business in a URL, a log, or a referer.
     */
    /**
     * The one thing a region's deployment is allowed to tell this one.
     *
     * Push invalidation stops at a tier boundary structurally: this composite holds a contract and
     * the keys are the region's own, so a `STALE` about them has nobody to send and the design's
     * stated fallback is the client's own refresh interval. What was missing is not a protocol, it
     * is an authority — who may say that a region this page composes has gone stale — and that is a
     * deployment's decision, so it is a secret in `weft.config.ts` rather than a mechanism here.
     *
     * A caller names a **region**, never a slot, and this side works out which slots on which pages
     * that region fills and which connections are showing them. Naming a slot would be a region
     * reaching into a page it cannot see, which is the thing composition refuses everywhere else.
     */
    if (path === STALE_PATH) {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' }).end('{"code":"E_METHOD"}')
        return
      }
      const answer = await serveStale(incoming, { routes, hub, regions: app.config.regions })
      res.writeHead(answer.status, Object.fromEntries(answer.headers))
      res.end(await answer.text())
      return
    }

    if (path === TOKEN_PATH) {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' }).end('{"code":"E_METHOD"}')
        return
      }
      const minted = await serveToken({ request: incoming, authority, intents, ports: app.ports })
      const out_ = Object.fromEntries(minted.headers)
      res.writeHead(minted.status, out_)
      res.end(await minted.text())
      return
    }

    /**
     * The request, recorded before it is served.
     *
     * The route comes from the same matcher the kernel is about to use, and where the reader came
     * from is the `Referer` matched against the same table — which is the only way to learn a
     * transition without asking the client to report one. A staged navigation sends a referer too,
     * so a page reached by a swap counts the same as a page reached by a load.
     */
    const readable = req.method === 'GET' || req.method === 'HEAD'
    const matched = readable ? table.match(url) : null
    if (recorder && matched) {
      const referer = req.headers.referer
      const from = referer ? patternOf(referer) : undefined
      recorder.request(matched.pattern, from)
    }

    const kernel = kernelFor(res)
    const response = await kernel.serve(incoming)

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

    /**
     * A conditional answer, for a route that asked to be one.
     *
     * The digest has to be over the whole entity and the kernel's envelope is sealed before the
     * first body byte, so the tag cannot come from in there — it comes from here, where the status
     * line has not been written yet, and the price is that the body is held until it is complete.
     * That is why the route declares it: `E_ETAG_STREAMS` refuses the combination that would make
     * this a silent slowdown.
     *
     * `no-store` gets no tag. A validator is a promise about a copy the client keeps, and the
     * response has just told it not to keep one.
     */
    if (matched && conditional.has(matched.pattern) && response.status === 200 && response.body) {
      const stored = !/no-store/.test(String(out['cache-control'] ?? ''))
      const whole = new Uint8Array(await response.arrayBuffer())
      if (stored) {
        const tag = await entityTag(whole)
        out.etag = tag
        if (matchesTag(req.headers['if-none-match'], tag)) {
          // No content-length on a 304: it describes a body that is deliberately absent.
          res.writeHead(304, out)
          res.end()
          return
        }
      }
      res.writeHead(response.status, { ...out, 'content-length': String(whole.byteLength) })
      res.end(req.method === 'HEAD' ? undefined : whole)
      await warm(matched, url)
      return
    }

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
    // After the last byte, not before: the whole point is that this render is not on the reader's
    // request. `finish` rather than `close`, because a socket that went away has nobody to warm for.
    res.once('finish', () => void warm(matched, url))
  }

  /**
   * Queue what this request implies and run it.
   *
   * On Workers the platform drains this queue as `waitUntil` and this call is the no-op it should
   * be. On Node nobody drains it, which is why `revalidateAfterResponse` had collected tasks for as
   * long as it had existed and run none of them.
   */
  async function warm(
    matched: { pattern: string; params: Record<string, string> } | null,
    url: URL,
  ): Promise<void> {
    if (!matched || !speculation.patterns.length) return
    try {
      // The request's own URL, because a key can be derived from the query string and a pattern
      // has none — warming under the wrong key is worse than not warming.
      await speculation.after(matched.pattern, matched.params, url)
      await speculation.drain()
    } catch (error) {
      // A speculative render that fails has cost a reader nothing, so it is reported and dropped.
      process.stderr.write(`  speculation failed on ${matched.pattern}: ${(error as Error).message}\n`)
    }
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
  if (typeof address === 'string' || address === null)
    throw new Error(
      'E_NO_ADDRESS: the server reported no TCP address after listening, so nothing can be told where to connect',
    )

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

/**
 * What a browser is shown when an intent refuses it.
 *
 * Every line here is something the reader or the person building the application can act on: the
 * code, the reason the dispatch gave, a way back to the page they were on, and — for the one
 * refusal that is a design decision rather than a mistake — what that decision is.
 */
function refusalPage(code: string, detail: string, css: string, request: Request): string {
  const back = request.headers.get('referer')
  const why =
    code === 'E_INTENT_UNSIGNED'
      ? `<p class="weft-lede">This intent requires a token this deployment minted for you, and a
         plain form post cannot carry one — a token cannot be rendered into a page, because a page
         can be cached and a token cannot. So this is the one kind of mutation that needs
         JavaScript, and every other one here still works without it. See
         <code>spec/kernel/authority.md</code>.</p>`
      : ''
  const link = back ? `<p><a href="${escapeAttribute(back)}">Back to the page</a></p>` : ''
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeText(code)}</title>
  <link rel="stylesheet" href="${css}"></head>
  <body><main class="weft-main"><h1><code>${escapeText(code)}</code></h1>
  <p class="weft-lede">${escapeText(detail)}</p>${why}${link}</main></body></html>`
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;')
}
