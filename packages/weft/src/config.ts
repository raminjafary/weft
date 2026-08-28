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
  FanoutPort,
  StaleJournal,
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
  /**
   * Defaults to 3000. A port on the WHATWG bad-port list is `E_BLOCKED_PORT` rather than a
   * deployment whose documents serve perfectly and whose channel silently never connects.
   */
  port?: number
  /** What the server binds to. Defaults to `localhost`, which is not reachable from another host. */
  host?: string
  /** Extra stylesheets, in order, after the framework's own. Paths are relative to the project. */
  css?: string[]
  /**
   * What the layout's nav links to. Without one it is derived from every route with no parameter,
   * which is right for a small application and editorial the moment there are forty pages.
   */
  nav?: { href: string; label: string }[]
  /**
   * How long a shared cache may serve a prerendered document before asking again, in seconds, and
   * `stale` the grace period after that. Defaults to 0, and to an hour of any non-zero `shared`.
   *
   * Stated rather than assumed, because only the deployment knows whether a deploy purges the
   * caches in front of it. See `spec/kernel/static.md`.
   */
  documents?: { shared?: number; stale?: number }
  /** Where the store lives. Defaults to an in-process one, which is a single-process deployment. */
  store?: StorePort
  /** Flag axes. Only a declared axis can be read, so a typo is a build error rather than a branch. */
  flags?: Record<string, string[]>
  /**
   * What the session cookie is called. Defaults to `sid`. The name and nothing else — the rest is
   * `SessionPort`'s. Here because two applications behind one host cannot both be `sid`.
   */
  session?: { cookie?: string }
  /**
   * Executors beyond `inline` and `client`. A slot naming one that is not bound here fails the
   * build with the slot named, rather than refusing at request time.
   */
  executors?: Record<string, KernelExecutor>
  /**
   * Where spans and counters go. Unbound, they are computed and dropped — the kernel measures a
   * render whether or not anybody is listening, because a number that exists only when telemetry is
   * bound is a number that changes the thing it measures.
   */
  telemetry?: TelemetryPort
  /**
   * Where each region a route composes actually is: a route says `search`, and this says what
   * `search` is right now. A roll is a write here rather than a rebuild of every page that composes
   * it. Unbound for a region a route declares, `E_NO_SUCH_REGION` at startup.
   *
   * See `spec/kernel/composition.md`.
   */
  regions?: readonly RegionBinding[]
  /**
   * A registry that answers regions from somewhere live — a KV namespace, a control plane. Asked
   * first when bound; `regions` above answers a name it does not resolve.
   */
  registry?: Registry
  /**
   * Where settings come from. Defaults to `WEFT_`-prefixed environment variables. One of three
   * ports whose defaults are real rather than stubs — see `spec/kernel/ports.md`.
   */
  config?: ConfigPort
  /**
   * What this build calls itself, and where it is running. Read by the trace, by `weft verify` and
   * by every region answering a probe, so the default reads the host's own idea of a revision.
   */
  deployment?: DeploymentPort
  /**
   * Where a loader's data comes from, named rather than anonymous. The default bounds access by a
   * deadline and counts it, so a loader that hangs degrades a slot rather than never ending.
   */
  db?: DbPort
  /**
   * What a call is counted against, and — only if you want to own it — how the counting is done.
   *
   * `{ counted }` and the framework counts in a fixed window against the bound store; `counted` is
   * the part it will not guess at. A whole `LimitPort` replaces the counting. Unbound, an intent
   * declaring a `limit` is `E_NO_RATE_LIMIT` at startup. See `spec/kernel/authority.md`.
   */
  limits?: LimitPort | { counted: CountedAgainst }
  /**
   * The channel's mount point, and whether this deployment can hold a downstream open.
   *
   * `hold: false` describes a serverless function, and said here the client takes turns from the
   * first request rather than discovering it on a failed intent. See `spec/kernel/transport.md`.
   */
  channel?: { path?: string; hold?: boolean }
  /**
   * How many instances of this deployment run at once. One unless it says otherwise.
   *
   * Declared because an instance cannot see its siblings, and declaring it is what lets the build
   * check the guarantees that depend on it — a process-scoped store holds N private caches on N
   * instances. See `spec/kernel/transport.md`.
   */
  instances?: number
  /**
   * Where this application is served from, for the things that are absolute by specification —
   * a sitemap's entries and a canonical link. Unset, neither is written: an absence rather than a
   * guess, since the same output is served from a preview URL, a staging host and a domain.
   */
  site?: { origin?: string }
  /**
   * How an invalidation reaches the instances this one is not. Needed exactly when `instances` is
   * more than one, and inert when it is one.
   */
  fanout?: FanoutPort
  /**
   * Where an invalidation waits for a client that is not connected. Bind `storeJournal(store)` when
   * this deployment serves turns and something writes; a process-scoped store is refused with
   * `E_TAGS_PROCESS_SCOPED`. Unbound is no journal rather than a degraded one.
   *
   * See `spec/kernel/transport.md`.
   */
  journal?: StaleJournal
  /**
   * Who may run an intent, and which intents need a token this deployment minted.
   *
   * Unbound, an intent that declares a capability is `E_NO_CAPABILITY_CHECK` and one that declares
   * `signed` is `E_NO_VERIFIER` — a declaration nothing enforces is worse than no declaration at
   * all. See [`spec/kernel/authority.md`](../../../spec/kernel/authority.md).
   */
  authority?: AuthorityConfig
  /**
   * Where the reader lands when the framework answers a link itself. `top` by default;
   * `data-weft-scroll="preserve"` on a link wins over whatever is set here, and neither setting
   * touches back and forward. See `spec/client/navigation.md`.
   */
  navigation?: { scroll?: 'top' | 'preserve' }
  /** Per-request ceiling on concurrent slot renders. Forty queries from one page will melt a database. */
  maxConcurrency?: number
  /** Type information decides escape elision. Turning it off is correct and slower. */
  types?: boolean
  /**
   * Record what every render costs into `.weft/profile.json`, and generate the next plan from it.
   * Off by default: a recording is only worth having from traffic that resembles production. See
   * `spec/plan/profile.md`.
   */
  profile?: boolean
  /**
   * `weft routes` and `weft why` as pages under `/_weft/devtools`, reading this process's own `App`
   * object. `weft dev` only — left on, `weft start` refuses by name. See `spec/plan/plan.md`.
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
  /** False on a deployment with no process to hold a connection. See `WeftConfig.channel`. */
  channelHold: boolean
  /** How many instances run at once. See `WeftConfig.instances`. */
  instances: number
  /** Where this application is served from. See `WeftConfig.site`. */
  origin?: string
  /** Cross-instance invalidation. See `WeftConfig.fanout`. */
  fanout?: FanoutPort
  /** Where an invalidation waits for a turn. See `WeftConfig.journal`. */
  journal?: StaleJournal
  /** Where a route change lands when the framework answers a link. See `WeftConfig.navigation`. */
  scroll: 'top' | 'preserve'
  maxConcurrency: number
  /** See `WeftConfig.documents`. Both in seconds; `shared: 0` is a cache that may never answer. */
  documents: { shared: number; stale: number }
  devtools: boolean
  profile: boolean
  types: boolean
  store?: StorePort
  /** Where spans and counters go. See `WeftConfig.telemetry`. */
  telemetry?: TelemetryPort
  config?: ConfigPort
  /** What this build calls itself, and where it is running. See `WeftConfig.deployment`. */
  deployment?: DeploymentPort
  /** Where a loader's data comes from. See `WeftConfig.db`. */
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

/**
 * Ports a browser will not connect to, whatever is listening on them: the WHATWG fetch standard's
 * bad-port list, copied rather than approximated because the standard names each port individually.
 *
 * See `spec/kernel/transport.md` for the failure this refuses, which this repository shipped.
 */
const BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104,
  109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515,
  526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
])

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
  const port = config.port ?? 3000
  if (BLOCKED_PORTS.has(port)) {
    throw new Error(
      `E_BLOCKED_PORT: ${port} is on the WHATWG bad-port list, so a browser refuses every ` +
        `fetch() and WebSocket to it. The documents would still be served and the channel would ` +
        `never connect — silently, because a blocked request reports no error the page can see. ` +
        `Pick another port.`,
    )
  }
  return {
    root,
    srcDir: config.srcDir ?? 'app',
    outDir: config.outDir ?? '.weft',
    port,
    host: config.host ?? 'localhost',
    css: config.css ?? [],
    ...(config.nav ? { nav: config.nav } : {}),
    flags: config.flags ?? {},
    session: { cookie: config.session?.cookie ?? 'sid' },
    executors: config.executors ?? {},
    channelPath: config.channel?.path ?? '/_weft/channel',
    channelHold: config.channel?.hold ?? true,
    instances: config.instances ?? 1,
    ...(config.site?.origin ? { origin: config.site.origin } : {}),
    ...(config.fanout ? { fanout: config.fanout } : {}),
    ...(config.journal ? { journal: config.journal } : {}),
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
