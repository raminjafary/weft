import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { access } from 'node:fs/promises'
import type {
  ConfigPort,
  DbPort,
  DeploymentPort,
  KernelExecutor,
  LimitPort,
  RegionBinding,
  Registry,
  StorePort,
  TelemetryPort,
} from '@weftjs/kernel'
import type { CountingLimitOptions } from '@weftjs/adapters'
import type { AuthorityConfig } from './authority.ts'

/** The one decision the `limits` port exists to refuse to make. See `WeftConfig.limits`. */
export type CountedAgainst = CountingLimitOptions['counted']

/**
 * The one file a deployment writes, and the only place it states what it binds.
 *
 * This is `KernelOptions` with a front door. Everything is optional: an application with no
 * config file gets an in-process store, a cookie session, no flag axes and `inline` as the
 * only executor — which is a real deployment for one process and an honest starting point
 * for any other, because the moment a port is bound here nothing else in the application
 * changes.
 */
export interface WeftConfig {
  /** Defaults to `app`. */
  srcDir?: string
  /** Where `weft build` writes. Defaults to `.weft`. */
  outDir?: string
  port?: number
  host?: string
  /** Extra stylesheets, in order, after the framework's own. Paths are relative to the project. */
  css?: string[]
  /**
   * What the layout's nav links to. Without one the framework derives it from every route with no
   * parameter, which is right for a small application and wrong the moment there are forty pages
   * — at which point the answer is editorial and belongs to whoever is writing the application.
   */
  nav?: { href: string; label: string }[]
  /**
   * How long a shared cache may serve a prerendered document before asking again, in seconds.
   *
   * L0 is the tier the build proved invariant, and until now nothing downstream could act on that.
   * A document went out `public, max-age=0, must-revalidate`, which lets a CDN store it and forbids
   * it from ever answering with it — so every navigation to a page that had been rendered at build
   * time still cost an origin round trip, and a tier a shared cache cannot hold is not really a
   * tier. That default is honest for a cache nobody purges, and wrong for every platform that
   * purges on deploy, which is most of them.
   *
   * So it is a number the deployment states rather than one the framework assumes. Set it when a
   * deploy clears the caches in front of this application; leave it at zero when it does not,
   * because the failure it buys is a page from the previous build served with no way to tell.
   * The browser is unaffected either way — `max-age=0` stays, so a reader still revalidates and
   * still gets a 304 against the ETag.
   *
   * `stale` is the grace period after that, during which a shared cache answers from what it has
   * and refreshes behind the request. Defaults to an hour of any non-zero `shared`.
   */
  documents?: { shared?: number; stale?: number }
  /** Where the store lives. Defaults to an in-process one, which is a single-process deployment. */
  store?: StorePort
  /** Flag axes. Only a declared axis can be read, so a typo is a build error rather than a branch. */
  flags?: Record<string, string[]>
  session?: { cookie?: string }
  /**
   * Executors beyond `inline` and `client`. A slot naming one that is not bound here fails the
   * build with the slot named, rather than refusing at request time.
   */
  executors?: Record<string, KernelExecutor>
  telemetry?: TelemetryPort
  /**
   * Where each region a route composes actually is.
   *
   * The indirection the whole of composition rests on: a route says `search`, and this says what
   * `search` is right now. Rolling a region to a new revision is a write here rather than a rebuild
   * of every page that composes it — which is why it is a deployment's file and not a route's
   * declaration, and why `weft verify` compares the two rather than assuming they agree.
   *
   * A region declared on a route with no binding here is `E_NO_SUCH_REGION` at startup, named by
   * `weft verify` rather than found by a reader.
   */
  regions?: readonly RegionBinding[]
  /**
   * A registry that answers regions from somewhere live — a KV namespace, a control plane.
   *
   * `regions` above is the checked-in shape of the same port and is the right answer for most
   * deployments. This is for the one where a roll is not a deploy: bound, it is asked first, and
   * `regions` is what answers a name it does not resolve.
   */
  registry?: Registry
  /**
   * Three ports a deployment may bind and most never have to.
   *
   * The defaults are real rather than stubs: settings come from `WEFT_`-prefixed environment
   * variables, the deployment names itself from whatever the host calls a revision, and data
   * access is bounded by a deadline and counted. Binding one replaces one decision and leaves the
   * other two alone, which is the whole claim a port makes.
   */
  config?: ConfigPort
  deployment?: DeploymentPort
  db?: DbPort
  /**
   * What a call is counted against, and — only if you want to own it — how the counting is done.
   *
   * Two shapes, because there are two decisions and only one of them is usually yours. Supply
   * `{ counted }` and the framework counts, in a fixed window, against the store this deployment
   * already bound; `counted` is the part it will not guess at, since an address, a session and a
   * subject are each wrong in some deployment. Supply a whole `LimitPort` — a gateway, a Redis
   * script, a platform's own limiter — and nothing else changes.
   *
   * Unbound, an intent that declares a `limit` is `E_NO_RATE_LIMIT` and says so at startup. Refused
   * rather than let through, because a limit nothing counts reads as a protection that is not there.
   */
  limits?: LimitPort | { counted: CountedAgainst }
  channel?: { path?: string }
  /**
   * Who may run an intent, and which intents need a token this deployment minted.
   *
   * Unbound, an intent that declares a capability is `E_NO_CAPABILITY_CHECK` and one that declares
   * `signed` is `E_NO_VERIFIER` — refused rather than waved through, because a declaration nothing
   * enforces is worse than no declaration at all. See [`spec/kernel/authority.md`](../../../spec/kernel/authority.md).
   */
  authority?: AuthorityConfig
  /**
   * What a route change does, for the pages this application serves.
   *
   * `scroll` decides where the reader lands when the framework answers a link itself. `top` is the
   * default because it is what a navigation has always done, and a swap that silently kept the
   * position would be a framework quietly changing what a link means. `preserve` is for the
   * applications where the position *is* the reader's place — a long list with a filter in the
   * URL, a document with a chapter per route — and it can be asked for one link at a time with
   * `data-weft-scroll="preserve"` in the markup, which wins over whatever is set here.
   *
   * Neither setting touches back and forward: those restore the position recorded on the entry
   * being returned to, which is what a browser does and what a reader means by going back.
   */
  navigation?: { scroll?: 'top' | 'preserve' }
  /** Per-request ceiling on concurrent slot renders. Forty queries from one page will melt a database. */
  maxConcurrency?: number
  /** Type information decides escape elision. Turning it off is correct and slower. */
  types?: boolean
  /**
   * Record what every render costs, and generate the next plan from it.
   *
   * Off by default, because a recording is only worth having from traffic that resembles
   * production and a laptop's is not that. On, the process writes `.weft/profile.json` as it
   * serves, and the next `weft build` or `weft dev` reads it: a slow region on a page with a fast
   * one starts streaming, a page whose regions are all fast stops paying for the out-of-order
   * filler, and the framework knows which routes readers actually go to next.
   */
  profile?: boolean
  /**
   * `weft routes` and `weft why` as pages, under `/_weft/devtools`, reading this process's own
   * `App` object.
   *
   * `weft dev` only. Left on, `weft start` refuses by name rather than serving a deployment's
   * route table, effect sets and cache-key reasons to anyone who asks for them.
   */
  devtools?: boolean
}

/** An identity function that exists for the types, so a config file is checked as it is written. */
export function defineConfig(config: WeftConfig): WeftConfig {
  return config
}

/** The config with every default filled in, so nothing downstream has to know what a default is. */
export interface ResolvedConfig extends Required<Pick<WeftConfig, 'srcDir' | 'outDir' | 'port' | 'host'>> {
  root: string
  css: string[]
  nav?: { href: string; label: string }[]
  flags: Record<string, string[]>
  session: { cookie: string }
  executors: Record<string, KernelExecutor>
  channelPath: string
  /** Where a route change lands when the framework answers a link. See `WeftConfig.navigation`. */
  scroll: 'top' | 'preserve'
  maxConcurrency: number
  /** See `WeftConfig.documents`. Both in seconds; `shared: 0` is a cache that may never answer. */
  documents: { shared: number; stale: number }
  devtools: boolean
  profile: boolean
  types: boolean
  store?: StorePort
  telemetry?: TelemetryPort
  config?: ConfigPort
  deployment?: DeploymentPort
  db?: DbPort
  limits?: LimitPort | { counted: CountedAgainst }
  authority?: AuthorityConfig
  regions: readonly RegionBinding[]
  registry?: Registry
  /** The config file that produced this, for a message that has to name it. */
  file?: string
}

const CANDIDATES = ['weft.config.ts', 'weft.config.js', 'weft.config.mjs']

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Load `weft.config.ts`, apply overrides, and fill in the defaults. An absent file is fine. */
export async function loadConfig(root: string, overrides: WeftConfig = {}): Promise<ResolvedConfig> {
  let file: string | undefined
  let loaded: WeftConfig = {}
  for (const candidate of CANDIDATES) {
    const path = join(root, candidate)
    if (!(await exists(path))) continue
    const module_ = (await import(pathToFileURL(path).href)) as { default?: WeftConfig }
    if (!module_.default) {
      throw new Error(`E_CONFIG_NO_DEFAULT: ${candidate} has to default-export defineConfig({…})`)
    }
    loaded = module_.default
    file = candidate
    break
  }
  const config = { ...loaded, ...overrides }
  return {
    root,
    srcDir: config.srcDir ?? 'app',
    outDir: config.outDir ?? '.weft',
    port: config.port ?? 3000,
    host: config.host ?? 'localhost',
    css: config.css ?? [],
    ...(config.nav ? { nav: config.nav } : {}),
    flags: config.flags ?? {},
    session: { cookie: config.session?.cookie ?? 'sid' },
    executors: config.executors ?? {},
    channelPath: config.channel?.path ?? '/_weft/channel',
    scroll: config.navigation?.scroll === 'preserve' ? 'preserve' : 'top',
    maxConcurrency: config.maxConcurrency ?? 6,
    documents: {
      shared: config.documents?.shared ?? 0,
      stale: config.documents?.stale ?? (config.documents?.shared ? 3600 : 0),
    },
    types: config.types ?? true,
    devtools: config.devtools ?? false,
    profile: config.profile ?? false,
    ...(config.store ? { store: config.store } : {}),
    ...(config.telemetry ? { telemetry: config.telemetry } : {}),
    ...(config.config ? { config: config.config } : {}),
    ...(config.deployment ? { deployment: config.deployment } : {}),
    ...(config.db ? { db: config.db } : {}),
    ...(config.limits ? { limits: config.limits } : {}),
    ...(config.authority ? { authority: config.authority } : {}),
    regions: config.regions ?? [],
    ...(config.registry ? { registry: config.registry } : {}),
    ...(file ? { file } : {}),
  }
}
