import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { access } from 'node:fs/promises'
import type { KernelExecutor, StorePort, TelemetryPort } from '@weft/kernel'

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
  channel?: { path?: string }
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
   * `weft routes` and `weft why` as pages, under `/_weft/devtools`, reading this process's own
   * `App` object.
   *
   * `weft dev` only. Left on, `weft start` refuses by name rather than serving a deployment's
   * route table, effect sets and cache-key reasons to anyone who asks for them.
   */
  devtools?: boolean
}

export function defineConfig(config: WeftConfig): WeftConfig {
  return config
}

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
  devtools: boolean
  types: boolean
  store?: StorePort
  telemetry?: TelemetryPort
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
    types: config.types ?? true,
    devtools: config.devtools ?? false,
    ...(config.store ? { store: config.store } : {}),
    ...(config.telemetry ? { telemetry: config.telemetry } : {}),
    ...(file ? { file } : {}),
  }
}
