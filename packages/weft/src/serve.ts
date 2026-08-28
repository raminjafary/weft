import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { access, readFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { Readable, type Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { patchPayload, render } from '@weftjs/ir'
import { entityTag, matchesTag } from './entity.ts'
import { isScopedSheet, scopeAttribute, scopeCss, scopeStem } from './scoped.ts'
import { frame, str, type Frame } from '@weftjs/warp'
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
} from '@weftjs/adapters'
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
} from '@weftjs/kernel'
import { verifyRegions, type VerifyReport } from '@weftjs/plan'
import {
  addressedByDigest,
  browserModule,
  buildAssets,
  MISS,
  moduleGraph,
  modulePreloads,
  cacheControlFor,
  moduleFileName,
  revAssets,
  rewriteUrls,
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
 * The application, served: a kernel with a ports record, a router, a channel hub with a slot source,
 * an intent dispatch on two bindings, module serving, asset revving and a stylesheet. None of it is
 * application-specific, which is why none of it belongs in an application.
 *
 * See `spec/kernel/lifecycle.md` for the front door and `spec/kernel/static.md` for the modules.
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
   * Fragments a client may ask for by opaque id, from `app/renderables/`. Empty means the registry
   * answers none, so a client naming one is `E_NO_SUCH_RENDERABLE`.
   */
  catalogue: Catalogue
  routes: GeneratedRoute[]
  store: StorePort
  hub: ChannelHub
  /**
   * What each open channel is: which page, and whose session. A channel has no request, so the
   * client says where it is when it opens one.
   */
  at: Map<string, Connection>
  assets: AssetTable
  /**
   * L0. Documents the build resolved and proved invariant, by the path each one answers. Populated
   * by `weft start` and empty everywhere else.
   */
  documents: Map<string, ServedDocument>
  diagnostics: string[]
  /**
   * What this deployment resolved about its own regions, or null for one that composes none. The
   * half that needs no network; the half that needs one is `weft verify`.
   */
  regions: VerifyReport | null
  /**
   * Everything a reader should be told before the first request rather than by a 501 in front of
   * somebody. Authority's refusals, and a region nothing can resolve.
   */
  warnings: string[]
  mode: Mode
  /**
   * What this process is recording, and what the last recording decided. Both null unless `profile`
   * is on. See `spec/plan/profile.md`.
   */
  recorder: Recorder | null
  decided: Decisions | null
  /** What this deployment bound, built once and shared by every path that needs ports. */
  ports: Ports
  /** The live-slot keys a set of write tags reaches, for a notify that has to name keys. */
  keysFor(tags: readonly string[]): string[]
  /**
   * Re-derive every connection's exposed shell values and tell whoever's changed. On the app because
   * both intent bindings have to call it, and the hub can only see the channel's.
   */
  republishExposed(except?: string): Promise<void>
  /**
   * Who may run an intent here, and which intents need a token this deployment minted. Resolved once
   * and shared by both bindings: a capability enforced on one is a capability with a way around it.
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
   * The most recent invalidation this client says it has been told about. Only a turn sends it: the
   * journal is a record rather than a queue, so without a high-water mark one write becomes one
   * refresh per turn. See `spec/kernel/transport.md`.
   */
  since?: number
  /**
   * Routes this connection has been *told about*, by pattern. Held so a description can be scored —
   * see `spec/plan/profile.md`.
   */
  described?: Set<string>
}

/** A running application: the URL it answers on, and how to stop it. */
export interface Serving {
  url: string
  app: App
  close(): Promise<void>
}

/**
 * An application that answers requests, with nothing yet listening. `weft start` puts it on a TCP
 * port; a host that owns the socket takes the two callbacks. See `spec/kernel/lifecycle.md`.
 */
export interface Handler {
  app: App
  /** A request, answered. Never throws: a failure below it becomes the error document. */
  handle(req: IncomingMessage, res: ServerResponse): void
  /** A channel open. Ends the socket when the path is not one, which is what a 404 is here. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void
  /** Stop the periodic work. Nothing is listening, so there is no socket to close. */
  close(): Promise<void>
}

const utf8 = new TextEncoder()

/** Which frame kinds change what the reader sees. The same set `region-channel.ts` uses. */
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
 * Where a package's servable source lives. Falls back to `src` so `weft dev` works on a fresh clone,
 * before anything in this repository has been built.
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
   * The limiter, from whichever half the config supplied: `counted` alone leaves the counting to the
   * framework, over the store everything else here shares; a whole port owns both.
   */
  const limits =
    config.limits && 'check' in config.limits
      ? config.limits
      : config.limits
        ? countingLimits({ store, counted: config.limits.counted })
        : undefined

  const configPort = config.config ?? envConfig()
  // The catalogue, resolved late for the same reason the asset table is: the registry answers
  // renderables, and the catalogue's entries compose through the ports that carry the registry.
  // One late binding rather than three constructors that each want the other two.
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

  // Read before the plan is generated because it is an input to it: delivery comes from the profile
  // where there is one and from the declaration where there is not.
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
    // What the intents in this application say they write, so the static tier refuses a page a
    // mutation would invalidate rather than freezing it. Both halves are declarations already.
    written: new Set(intents.entries.flatMap((entry) => entry.writes)),
    runtime: () => table().boot,
    preload: () => preloads,
    /**
     * The path a pattern answers with these params filled in, as an absolute canonical link. Built
     * from the pattern rather than from the request — see `spec/kernel/static.md`.
     */
    canonical: (pattern, params) => {
      if (!config.origin) return ''
      const path = pattern.replace(/:([A-Za-z0-9_]+)/g, (_, name: string) => params[name] ?? `:${name}`)
      const href = `${config.origin.replace(/\/+$/, '')}${path}`
      const safe = href.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      // Both tags: the same claim. What a share card says is the application's, in its layout.
      return `<link rel="canonical" href="${safe}"><meta property="og:url" content="${safe}">`
    },
    brand: basename(root) || 'weft',
  })

  // `app/assets/` is walked before a single stylesheet is read: a sheet's `url()` is rewritten to a
  // revved href, and after concatenation there is no telling which line came from which file.
  const appAssets = await revAssets(join(root, config.srcDir, 'assets'), mode !== 'dev')
  const styled = (text: string, file: string): string => rewriteUrls(text, dirname(file), appAssets.byPath)

  const shared: string[] = [`/* weft */\n${await frameworkStyles()}`]
  if (discovered.styles) {
    shared.push(
      `/* ${config.srcDir}/styles.css */\n${styled(await readFile(discovered.styles, 'utf8'), discovered.styles)}`,
    )
  }
  for (const file of config.css) {
    const path = join(root, file)
    shared.push(`/* ${file} */\n${styled(await readFile(path, 'utf8'), path)}`)
  }
  // A scoped sheet, narrowed once and reused: the rewrite is pure, so it is memoised by path rather
  // than repeated per route.
  const narrowed = new Map<string, string>()
  const sheet = async (file: string): Promise<string> => {
    const held = narrowed.get(file)
    if (held !== undefined) return held
    const body = styled(await readFile(file, 'utf8'), file)
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
    assets: appAssets,
    client: await ownTree(),
    runtime: await packageTree('@weftjs/client'),
    warp: await packageTree('@weftjs/warp'),
    ...(discovered.client ? { app: { dir: dirname(discovered.client), ext: '.ts' as const } } : {}),
    // Dev must never cache: a stylesheet you just edited, served as immutable, lies for a year.
    revved: mode !== 'dev',
  })
  setAssets(assets)

  /**
   * The preload list, computed once because it cannot change without a rebuild — and a graph that
   * could differ per request is a graph the byte budget could not have measured.
   */
  const preloads = modulePreloads(await moduleGraph(assets, assets.app), assets.boot)

  /**
   * One region of one route, composed for a channel. Built per call, because a `Composer`
   * accumulates the outcomes `composer.hops` counts.
   *
   * The same function answers a refresh and a stage — a second composition site is where the two
   * would drift. See `spec/kernel/composition.md`.
   */
  const composeRegion = (route: GeneratedRoute): ChannelRegions =>
    channelRegions({
      composer: createComposer({ ports }),
      regions: route.remote,
      route: () => route.pattern,
    })

  /**
   * The catalogue, built now that there is something to compose a region-served entry with. A
   * renderable named by a region goes through the same composer a slot does: one question, one
   * answer. What the entry adds is the params.
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
  // Which live slots carry which tag. A live slot's key is the framework's rather than an entry the
  // store wrote, so the store's tag index cannot reach it and this can.
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
   * The region checks that need no network, run before the first request: the name is wrong in a
   * config file and the person who can fix it is looking at a terminal. `weft verify` is the same
   * function with a probe and an exit code.
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

  // One route table, built once. Four matchers over one set of patterns is four chances for them to
  // disagree about which route a URL is.
  const router = createRouter(routes.map((route) => ({ pattern: route.pattern, value: route })))
  const routeAt = (path: string): ReturnType<typeof router.match> =>
    router.match(new URL(path, 'http://weft.local'))
  const here = (channel: { id: string }): ReturnType<typeof router.match> => {
    const connection = at.get(channel.id)
    return connection ? routeAt(connection.path) : null
  }
  const transitions = (): Record<string, string[]> => (recorded ? likelyNext(recorded) : {})

  /**
   * A route staged over the channel. Two decisions only this side can make: whether the target
   * shares this client's shell, and what each region's next state is — through the same loaders a
   * document request would run. See `spec/client/navigation.md`.
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
      // A description that paid. A stage of an undescribed pattern is a hover on a link the page
      // had anyway, and counting it would make every description look successful.
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
      // The target's remote regions, composed as part of staging it — otherwise the reader watches
      // the page assemble itself after the commit. Each is told the epoch, so it can split frames.
      const compose = composeRegion(target.value)
      for (const [name, spec] of Object.entries(target.value.remote)) {
        // The same derivation a document request does, so a staged region renders against the
        // values the page it is being staged for would have.
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
   * The part of the plan a client does not have, described rather than rendered. Nothing here runs a
   * loader, which is why a page can afford to know about thirty routes and stage two. See
   * `spec/client/navigation.md`.
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
   * Whether staging this route from that page is worth the request. Absent means unmeasured, and
   * unmeasured stages — the same rule delivery and discovery follow, so a cold recording cannot
   * switch staging off. See `spec/plan/profile.md`.
   */
  const worthStaging = (pattern: string, from?: string): boolean | undefined => {
    if (!decided || !from || from === pattern) return undefined
    const sources = decided.routes.find((r) => r.route === pattern)?.stage
    if (!sources?.length) return undefined
    return sources.includes(from)
  }

  /** Whether a route is worth describing, from the last recording. Absent means unmeasured. */
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
      // No prefix is the handshake, and it answers narrowly: this page, and where the profile says
      // its readers go next. A route table pushed at every page load is a cost every reader pays.
      if (prefix === undefined) {
        if (!from) return null
        // This page, then where the profile says its readers go, minus the never-followed.
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
      // A prefix somebody asked about is described whatever the recording says: a question is not
      // a volunteer, and the measurement is about what this deployment volunteers.
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

  // What each connection was last told the shell exposes, so a change can be sent as a change
  // rather than as a `SIGNAL` per name per write.
  const exposedTo = new Map<string, Record<string, string>>()

  /**
   * What was invalidated while this client had no connection to be told on. Only a turn can be in
   * that position, so on every other binding this is one null check and no store traffic.
   *
   * The keys are the route's own, decided at build time. `at` travels because the journal is a
   * record rather than a queue. See `spec/kernel/transport.md`.
   */
  const journaled = async (channel: { id: string; binding: string }): Promise<Frame[]> => {
    if (!config.journal || channel.binding !== 'turn') return []
    const from = here(channel)
    if (!from) return []
    const live = Object.entries(from.value.live)
    if (!live.length) return []
    const found = await config.journal.lookup(live.map(([, slot]) => slot.key))
    if (!found.size) return []
    const since = at.get(channel.id)?.since ?? 0
    const out: Frame[] = []
    for (const [name, slot] of live) {
      const entry = found.get(slot.key)
      // Filtered here: the server is the side that knows both numbers.
      if (entry && entry.at > since) out.push(frame('STALE', { s: name, reason: entry.reason, at: entry.at }))
    }
    return out
  }

  const declareExposed = async (channel: { id: string }): Promise<Frame[]> => {
    const from = here(channel)
    if (!from) return []
    const values = await from.value.exposed(from.params)
    if (!Object.keys(values).length) return []
    exposedTo.set(channel.id, values)
    return [frame('SIGNAL', {}, utf8.encode(JSON.stringify(values)), true)]
  }

  /**
   * Exposed values that changed, told to the connections showing them. Nothing is re-rendered: a
   * region decides for itself what a new value means for its own markup.
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
      // Through the channel rather than the hub: `notify` is about cache keys, and nobody holds a
      // shell value as an entry.
      await hub.get(id)?.send(changed.map(([name, v]) => frame('SIGNAL', { name, v })))
    }
  }

  /**
   * The render-intent dispatch, sharing every gate with the intent one — the same capability check,
   * verifier and limiter, bound from the same place. What it adds is the catalogue.
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
     * The two places an invalidation goes that this process cannot reach on its own. Neither may
     * throw and neither may be the reason the other did not run, so they are settled.
     */
    ...(config.fanout || config.journal
      ? {
          onInvalidated: async (keys: readonly string[], reason: string) => {
            const done = await Promise.allSettled([
              config.journal?.record(keys, reason),
              config.fanout?.publish(keys, reason),
            ])
            for (const [i, settled] of done.entries()) {
              if (settled.status === 'rejected')
                config.telemetry?.measure(`channel.${i ? 'fanout' : 'journal'}.failed`, 1, {
                  detail: String(settled.reason),
                })
            }
          },
        }
      : {}),
    // The second rung of the surgical ladder, bound here because the front door cannot know which
    // shape its application's regions have. See `spec/kernel/surgical.md`.
    patch: patchPayload,
    source: liveSource(routes, at, ports, composeRegion, {
      renders,
      names: catalogue.names,
      ports,
    }),
    /**
     * The real dispatch, with the framework's own live keys folded into what it dropped. A live
     * slot's key is not a store entry, so the hub's list from the store would miss every other tab.
     */
    intents: {
      run: async (id, raw, ctx, credentials) => {
        const outcome = await dispatch.run(id, raw, ctx, credentials)
        if (!outcome.ok) return outcome
        // The exposed set is the only channel a region has for hearing about this write.
        await republishExposed()
        const extra = keysFor(outcome.invalidated)
        return { ...outcome, dropped: [...new Set([...outcome.dropped, ...extra])] }
      },
    },
    /**
     * The context an intent runs against, built from the channel's own connection — which has to
     * carry the session, or an intent dispatched over the channel writes as nobody.
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
    /**
     * The key a slot this connection is showing would be held under, so a `HELD` is enough to make it
     * a candidate for an invalidation. Asked without running the loader: the question is which entry
     * this page is showing, not what it should show next.
     */
    keyFor: (slot, channel) => here(channel)?.value.live[slot]?.key,
    templates: (version) => compiled.templates.find((t) => t.version === version),
    warm: { at: stager, plan: discovery.warm },
    // The two things a connection is told without asking: the part of the plan it cannot know it is
    // missing, and the shell values its regions may read.
    onOpen: async (channel) => [
      ...((await discovery.open(channel)) ?? []),
      ...(await declareExposed(channel)),
      ...(await journaled(channel)),
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
    // The compiler's, and only the compiler's — `weft build` prints it under a heading that says so.
    // Authority's live on `authority.diagnostics`.
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
 * The channel's slot source. The path the client said it was on is matched against the same route
 * table the document went through and the slot's own loader re-run, so a refresh and a fresh
 * document request compute the same thing from the same code.
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
     * A render intent: `REFRESH s=<slot> r=<id>`. Two checks live here rather than in the dispatch,
     * because both are route knowledge and a channel has none — the slot has to be a hole on this
     * page, and the id may be the entry's declared name.
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
        // The gates get an envelope context; the entry's own loader gets `ctx`, which cannot write.
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
     * A region on another deployment, refreshed. Asked before this route's own slots because the two
     * name spaces are one and a hole is filled from exactly one of them.
     *
     * No `live` gate, deliberately: `live` is a statement about a fragment this process holds, and a
     * region's freshness is the region's own business.
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
 * The envelope context a render intent's *gates* run against, built from what the connection said.
 * An envelope one rather than a render one, because a capability check resolves a subject and a
 * verifier reads a token — both things a request that can still be refused does.
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
 * The read surface a channel refresh runs against. No envelope, because a refresh has no response to
 * write to, so a deferred effect is dropped rather than queued against a request that ended.
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
  // The same services a document render hands a loader: a context that differed between the two
  // would make the delta describe a render nobody could reproduce.
  return { ...reads, ...services(ports), phase: 'render', defer: () => {} }
}

/** Make it answerable. Everything interesting already happened in `createApp`. */
export async function appHandler(app: App): Promise<Handler> {
  const { assets, at, authority, config, documents, intents, keysFor, recorder, routes, store, hub } = app
  const table = createRouter<RouteResolver>(routes.map((route) => route.entry))
  // A set rather than a route lookup: consulted on the hot path, and the answer is build-time.
  const conditional = new Set(routes.filter((route) => route.etag).map((route) => route.pattern))

  /**
   * `.speculate()`, after the response: the one render per period that a TTL costs, moved off a
   * reader's request through the store's own after-response queue.
   */
  const speculation = createSpeculation({
    routes,
    store,
    ports: app.ports,
    onWarmed: (pattern, slot, ms) =>
      app.ports.telemetry?.measure('slot.speculated', ms, { route: pattern, slot }),
  })

  // No bundle for a page that is not a route, so a 404 borrows the first one's stylesheet.
  const firstCss = routes[0] ? assets.pageCss(routes[0].pattern) : ''

  /**
   * The error page: `app/layouts/error.tsx` when the application wrote one, the framework's own when
   * it did not. A named layout rather than a special file, and deliberately not a route — a 404 has
   * no path of its own.
   *
   * `src/assets/error.tsx` documents the values a replacement is handed.
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
    // Both bindings or neither, on the same argument capabilities make.
    ...(app.ports.limits ? { limits: app.ports.limits } : {}),
    returnTo: (request) => request.headers.get('referer') ?? '/',
  })

  /**
   * A write over plain HTTP still has to tell the open channels. The channel binding gets this free
   * — its dispatch lives inside the hub — and a form post does not.
   */
  const dispatchOverHttp = async (request: Request): Promise<Response> => {
    const response = await http.handle(request)
    /**
     * A refused mutation, told to whoever asked. A plain form post gets the page, because the
     * no-JavaScript path is not finished at "the request was refused correctly"; the framework's own
     * fetch sends a header and keeps the JSON, which it turns into a toast.
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
    // Both bindings again, for the reason above.
    await app.republishExposed()
    if (tags.length) await hub.invalidate(tags, 'a form post wrote it')
    const keys = keysFor(tags)
    if (keys.length) await hub.notify(keys, 'a form post wrote it')
    return response
  }

  /**
   * The other direction: what another instance dropped, applied to the readers held here. `notify`
   * and not `invalidate` — the keys are already gone, and re-invalidating would produce a message
   * per instance per write.
   */
  if (config.fanout) {
    void config.fanout.subscribe((keys, reason) => {
      void hub.notify(keys, reason).catch(() => undefined)
    })
  }

  const channel = channelHandlers({ hub, path: config.channelPath })
  // Null unless `devtools: true`, and a named refusal outside `weft dev`. Off, it is one null check.
  const devtools = devtoolsFor(app)

  const prelude = bootPrelude(app)

  // Modules already transformed, by URL. Bounded by a build-time constant: a request cannot invent
  // a module the application does not have.
  const served = new Map<string, string>()

  // The deployment's ports, plus the one that is per response: 103 goes out on a socket.
  const kernelFor = (res: ServerResponse): Kernel =>
    createKernel({
      ports: { ...app.ports, transport: nodeTransport(res) },
      coalesce: leaseCoalescer(store, { pollMs: 5 }),
      routes: table,
      notFound: (request) =>
        // The path is named and the route table is not: that list is a map of the site handed to
        // whoever mistypes a URL. `weft routes` prints it for the audience it was written for.
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

  function respond(req: IncomingMessage, res: ServerResponse): void {
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.end()
        return
      }
      // The trace in development, a sentence outside it: a stack names files, line numbers and often
      // the shape of the data being handled.
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
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? config.host}`)
    const path = url.pathname

    // Both are needed later, when there is no request to ask.
    remember(url, req.headers.cookie)
    if (channel.http(req, res)) return
    if (devtools && (await devtools(req, res))) return

    /**
     * L0, and the whole of what it costs at serve time: everything below this line is work with a
     * known answer. Only `weft start` populates the table. See `spec/kernel/static.md`.
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
      // A stable name is `no-cache`, which the client can only keep with a validator: the tag is
      // what makes a dev reload a 304 rather than the whole stylesheet again.
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
      // The URL always ends in `.js`; the file behind it may be `.ts`. See `servedModuleName`.
      const source = join(tree.dir, moduleFileName(name, tree))
      if (!(await exists(source))) {
        // Not stored by anybody: this URL names a digest, and a digest that has no file today may
        // have one after a rollback. See `MISS`.
        res
          .writeHead(404, { 'content-type': 'text/plain', 'cache-control': MISS })
          .end(`no such module: ${name}\n`)
        return
      }
      // Transformed once outside dev, because the answer cannot change: the source is not being
      // edited and the path already carries a digest. See `spec/kernel/static.md`.
      const cached = app.mode === 'dev' ? undefined : served.get(path)
      const body =
        cached ??
        browserModule(await readFile(source, 'utf8'), tree, prefix, {
          comments: app.mode === 'dev' ? 'keep' : 'strip',
        })
      if (!cached && app.mode !== 'dev') served.set(path, body)
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

    /**
     * A miss under a content-addressed root, answered before it becomes a page — a 404 from the
     * router carries a document's policy, which is wrong here for the reason `MISS` gives. Text
     * rather than the 404 page, because nothing asking for a module wants a document back.
     */
    if (addressedByDigest(path)) {
      res
        .writeHead(404, { 'content-type': 'text/plain', 'cache-control': MISS })
        .end(`no such asset: ${path}\n`)
      return
    }

    const headers = new Headers()
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(key, value)
      else if (Array.isArray(value)) for (const v of value) headers.append(key, v)
    }
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await requestBody(req)
    const incoming = new Request(url, { method: req.method ?? 'GET', headers, ...(body ? { body } : {}) })

    /**
     * The one thing a region's deployment is allowed to tell this one. A caller names a **region**,
     * never a slot — naming a slot would be a region reaching into a page it cannot see. See
     * `spec/kernel/composition.md`.
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
     * The request, recorded before it is served. Where the reader came from is the `Referer` matched
     * against the same table — the only way to learn a transition without asking the client.
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
     * Which slots the store answered for. A hit is the absence of a render, so it cannot be counted
     * where renders are; the trace names both keys and hits, for as long as the request lives.
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
    // Which build answered. See `spec/kernel/lifecycle.md`.
    if (app.ports.deployment) out['x-weft-revision'] = app.ports.deployment.revision

    /**
     * A conditional answer, for a route that asked to be one. The tag comes from here rather than
     * the envelope, and the price is that the body is held until it is complete — which is why the
     * route declares it. `no-store` gets no tag. See `spec/kernel/cache.md`.
     */
    if (matched && conditional.has(matched.pattern) && response.status === 200 && response.body) {
      const stored = !/no-store/.test(String(out['cache-control'] ?? ''))
      const whole = new Uint8Array(await response.arrayBuffer())
      if (stored) {
        const tag = await entityTag(whole)
        out.etag = tag
        if (matchesTag(req.headers['if-none-match'], tag)) {
          // No content-length on a 304.
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
     * A body that fails mid-stream has to end the response. The status line is long gone, so the
     * only honest signal is a truncated body — and leaving the socket open is indistinguishable
     * from a hung server. `onExceed: 'fail'` reaches this deliberately.
     */
    const out_ = Readable.fromWeb(response.body as never)
    out_.on('error', (error: Error) => {
      process.stderr.write(`  slot failed mid-stream on ${path}: ${error.message}\n`)
      res.destroy()
    })
    out_.pipe(res)
    // After the last byte: the point is that this render is not on the reader's request. `finish`
    // rather than `close`, because a socket that went away has nobody to warm for.
    res.once('finish', () => void warm(matched, url))
  }

  /**
   * Queue what this request implies and run it. On Workers the platform drains this as `waitUntil`
   * and the call is a no-op; on Node nobody drains it, so this does.
   */
  async function warm(
    matched: { pattern: string; params: Record<string, string> } | null,
    url: URL,
  ): Promise<void> {
    if (!matched || !speculation.patterns.length) return
    try {
      // The request's own URL: a key can derive from the query string, and a pattern has none.
      await speculation.after(matched.pattern, matched.params, url)
      await speculation.drain()
    } catch (error) {
      // A speculative render that fails has cost a reader nothing.
      process.stderr.write(`  speculation failed on ${matched.pattern}: ${(error as Error).message}\n`)
    }
  }

  /**
   * The recording, written every thirty seconds rather than on exit: the interesting case for a
   * profile is a process that was killed. Unref'd, so it cannot keep one alive.
   */
  const flushing = recorder
    ? setInterval(() => {
        void writeProfile(config.root, config.outDir, recorder.profile())
      }, 30_000)
    : null
  flushing?.unref()

  /**
   * Which route a URL belongs to, or nothing. A referer is a URL and a route is a pattern, so they
   * are never equal; matching with the router means one notion of "this URL is that page".
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
    const said = Number(url.searchParams.get('since') ?? '')
    at.set(id, {
      path: path ?? existing?.path ?? '/',
      cookie: cookie ?? existing?.cookie ?? '',
      // Never backwards: the value is the client's, and a stale tab would be told twice.
      since: Math.max(Number.isFinite(said) ? said : 0, existing?.since ?? 0),
    })
  }

  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? config.host}`)
    remember(url, req.headers.cookie)
    if (!channel.upgrade(req, socket as never, head)) socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
  }

  return {
    app,
    handle: respond,
    upgrade,
    close: async () => {
      if (flushing) clearInterval(flushing)
      // Also on the way out: the last thirty seconds of a load test are the ones worth including.
      if (recorder) await writeProfile(config.root, config.outDir, recorder.profile())
    },
  }
}

/** Put a handler on a TCP port. */
export async function serveHandler(handler: Handler): Promise<Serving> {
  const { config } = handler.app
  const server: Server = createServer(handler.handle)
  server.on('upgrade', handler.upgrade)

  // `localhost` rather than `127.0.0.1` — see `spec/kernel/lifecycle.md`.
  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve))
  const address = server.address()
  if (typeof address === 'string' || address === null)
    throw new Error(
      'E_NO_ADDRESS: the server reported no TCP address after listening, so nothing can be told where to connect',
    )

  return {
    url: `http://${config.host}:${address.port}/`,
    app: handler.app,
    close: async () => {
      await handler.close()
      await new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
    },
  }
}

/**
 * What the client needs before it can do anything, and the only things it cannot derive. Exported
 * because the boot module has two ways out of a deployment and they must not disagree. See
 * `spec/kernel/lifecycle.md`.
 */
export function bootPrelude(app: App): string {
  const { assets, authority, config, intents } = app
  return (
    `window.__weftIntents = ${JSON.stringify(intents.names)};\n` +
    `window.__weftChannel = ${JSON.stringify(config.channelPath)};\n` +
    // Only when false, on the same rule as `__weftSigned`.
    (config.channelHold ? '' : `window.__weftHold = false;\n`) +
    (authority.signed.length ? `window.__weftSigned = ${JSON.stringify(authority.signed)};\n` : '') +
    `window.__weftScroll = ${JSON.stringify(config.scroll)};\n` +
    (assets.app ? `window.__weftClient = ${JSON.stringify(assets.app)};\n` : '')
  )
}

/** Put it on a port. */
export async function serveApp(app: App): Promise<Serving> {
  return serveHandler(await appHandler(app))
}

/**
 * The bytes a request carried, from a host that may already have read them.
 *
 * Reading the stream is right when the framework owns the socket and wrong everywhere else. A
 * serverless platform with a body parser consumes the request to hand the handler a parsed
 * `req.body`, and what arrives here is a stream that will never emit another byte and never emit
 * `end` — so reading it does not fail, it waits, until the platform's own timeout ends the
 * request. On the documentation deployment that was every `POST`: an intent, a token, and a 404
 * alike, each one a 504 after thirty seconds, each one answered locally in ten milliseconds.
 *
 * So the parsed body is asked for first, and a stream already ended is not read at all. Neither is
 * a guess about the platform: `body` is either there or it is not, and `readableEnded` is the
 * stream saying so itself.
 */
async function requestBody(req: IncomingMessage): Promise<ArrayBuffer | undefined> {
  const held = (req as IncomingMessage & { body?: unknown }).body
  if (held !== undefined && held !== null) return encodeBody(held, req.headers['content-type'] ?? '')
  // Nothing left to read, and on some hosts nothing to wait for either.
  if (req.readableEnded) return undefined
  return new Response(Readable.toWeb(req) as never).arrayBuffer()
}

/**
 * A parsed body, put back the way it arrived.
 *
 * Lossless for the two shapes a host hands over untouched — bytes and text — and a reconstruction
 * for the one it does not. A form is rebuilt through `URLSearchParams` rather than joined by hand
 * because a repeated field is a list and a checkbox group is a repeated field, which is the case
 * a naive re-encode drops.
 */
/** A view's own bytes, detached from whatever buffer it was a window onto. */
function bytes(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
}

function encodeBody(held: unknown, type: string): ArrayBuffer {
  if (held instanceof Uint8Array) return bytes(held)
  if (typeof held === 'string') return bytes(utf8.encode(held))
  if (type.includes('x-www-form-urlencoded')) {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(held as Record<string, unknown>)) {
      if (Array.isArray(value)) for (const one of value) params.append(key, String(one))
      else params.append(key, String(value))
    }
    return bytes(utf8.encode(params.toString()))
  }
  return bytes(utf8.encode(JSON.stringify(held)))
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
