import type { EnvelopeContext } from './context.ts'

/**
 * Ports replace, plugins extend. Conflating the two is how plugin systems become
 * unmaintainable: a port has exactly one active implementation and answers "who does this
 * job"; a plugin adds behaviour at a defined point and answers "what else happens here".
 *
 * Two rules do most of the work. Reads are declared and enforced, because one careless
 * plugin reading undeclared request state silently makes every fragment uncacheable — which
 * is precisely how caching dies in real codebases. And a plugin may add a cache axis but
 * may never write a key: the moment a key can be hand-set it can drift from what the code
 * reads.
 *
 * What is in this module is what a request pays for. The ordering graph is in
 * `plugin-graph.ts` because it is build-time work, and the read enforcement is in
 * `plugin-guard.ts` because the design specifies it as a dev-time check.
 */
export type PluginResidency = 'server' | 'client' | 'both' | 'build'

export interface PluginResult {
  /** Values contributed to the context. Keys must be declared in `provides`. */
  provided?: Record<string, unknown>
  /** A filter may end the request. An enricher may not, and one that tries is an error. */
  response?: Response
}

export interface Plugin {
  name: string
  /** `filter` runs sequentially in phase A and may end the request; `enricher` runs in parallel waves. */
  role: 'filter' | 'enricher'
  residency?: PluginResidency
  before?: readonly string[]
  after?: readonly string[]
  reads?: readonly string[]
  provides?: readonly string[]
  /** A new cache dimension. The kernel folds it into the derived key; the plugin never sees the key. */
  planAxis?(): Record<string, string[]>
  critical?: boolean
  timeoutMs?: number
  capabilities?: readonly string[]
  onRequest?(
    ctx: EnvelopeContext,
    provided: Record<string, unknown>,
  ): Promise<PluginResult | void> | PluginResult | void
}

export class PluginError extends Error {
  code: string
  plugin: string

  constructor(code: string, plugin: string, message: string) {
    super(`${code} [${plugin}] — ${message}`)
    this.name = 'PluginError'
    this.code = code
    this.plugin = plugin
  }
}

export function definePlugin(plugin: Plugin): Plugin {
  return plugin
}

export interface PluginSchedule {
  /** Filters, in declared dependency order. Sequential, because short-circuiting requires sequence. */
  filters: Plugin[]
  /** Enrichers, in waves. Disjoint reads and provides run at once. */
  waves: Plugin[][]
  /** Every contributed cache axis, collected once. `planAxis()` takes no request, so it is not per-request work. */
  axes: Record<string, string[]>
}

/**
 * Wraps a context so a plugin's undeclared reads throw. Dev-only by design, so it is passed
 * in rather than imported: see `plugin-guard.ts`.
 */
export type ReadGuard = (plugin: Plugin, ctx: EnvelopeContext) => EnvelopeContext

export interface PluginRunResult {
  provided: Record<string, unknown>
  /** Set when a filter ended the request. */
  response?: Response
  /** Non-critical plugins that failed. Reported, never fatal. */
  skipped: { plugin: string; reason: string }[]
  axes: Record<string, string[]>
}

export async function runPlugins(
  schedule: PluginSchedule,
  ctx: EnvelopeContext,
  guard?: ReadGuard,
): Promise<PluginRunResult> {
  const provided: Record<string, unknown> = {}
  const skipped: { plugin: string; reason: string }[] = []
  const axes = schedule.axes

  const invoke = async (plugin: Plugin): Promise<PluginResult | void> => {
    if (!plugin.onRequest) return
    const seen = guard ? guard(plugin, ctx) : ctx
    try {
      return await withTimeout(plugin, () => Promise.resolve(plugin.onRequest?.(seen, provided)))
    } catch (error) {
      if (plugin.critical) throw error
      skipped.push({ plugin: plugin.name, reason: error instanceof Error ? error.message : String(error) })
      return
    }
  }

  const absorb = (plugin: Plugin, result: PluginResult | void): void => {
    if (!result?.provided) return
    const declared = new Set(plugin.provides ?? [])
    for (const [key, value] of Object.entries(result.provided)) {
      if (!declared.has(key)) {
        throw new PluginError(
          'E_PLUGIN_UNDECLARED_PROVIDE',
          plugin.name,
          `provided ${key} without declaring it`,
        )
      }
      provided[key] = value
    }
  }

  for (const plugin of schedule.filters) {
    const result = await invoke(plugin)
    absorb(plugin, result)
    if (result?.response) return { provided, response: result.response, skipped, axes }
  }

  for (const wave of schedule.waves) {
    const results = await Promise.all(wave.map((plugin) => invoke(plugin)))
    results.forEach((result, i) => {
      const plugin = wave[i] as Plugin
      if (result?.response) {
        throw new PluginError(
          'E_ENRICHER_RESPONDED',
          plugin.name,
          'an enricher cannot end the request; declare it as a filter',
        )
      }
      absorb(plugin, result)
    })
  }

  return { provided, skipped, axes }
}

async function withTimeout<T>(plugin: Plugin, work: () => Promise<T>): Promise<T> {
  if (plugin.timeoutMs === undefined) return work()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new PluginError('E_PLUGIN_TIMEOUT', plugin.name, `exceeded ${plugin.timeoutMs}ms`)),
          plugin.timeoutMs,
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
