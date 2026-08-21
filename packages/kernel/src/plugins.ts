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
}

/**
 * The dependency graph is inferred rather than declared. `reads` and `provides` give the
 * kernel everything it needs: B reads what A provides, so the edge exists without anybody
 * writing `after: ['A']`. Hand-declared edges stay for the cases data flow cannot express —
 * a CSP nonce must be injected before analytics adds a script tag, and no read/write
 * relationship captures that.
 */
export function resolvePlugins(plugins: readonly Plugin[]): PluginSchedule {
  const byName = new Map<string, Plugin>()
  for (const plugin of plugins) {
    if (byName.has(plugin.name)) {
      throw new PluginError('E_PLUGIN_DUPLICATE', plugin.name, 'registered twice')
    }
    byName.set(plugin.name, plugin)
  }

  const providers = new Map<string, string>()
  for (const plugin of plugins) {
    for (const key of plugin.provides ?? []) {
      const existing = providers.get(key)
      if (existing) {
        throw new PluginError(
          'E_PLUGIN_AMBIGUOUS',
          plugin.name,
          `${key} is already provided by ${existing}; ambiguity is caught rather than resolved by load order`,
        )
      }
      providers.set(key, plugin.name)
    }
  }

  const edges = new Map<string, Set<string>>()
  for (const plugin of plugins) edges.set(plugin.name, new Set())
  const edge = (from: string, to: string): void => {
    if (!byName.has(from) || !byName.has(to)) return
    edges.get(to)?.add(from)
  }

  for (const plugin of plugins) {
    for (const read of plugin.reads ?? []) {
      const provider = providers.get(read)
      if (provider && provider !== plugin.name) edge(provider, plugin.name)
    }
    for (const name of plugin.after ?? []) edge(name, plugin.name)
    for (const name of plugin.before ?? []) edge(plugin.name, name)
  }

  const order = topological(plugins, edges)
  const filters = order.filter((p) => p.role === 'filter')
  const enrichers = order.filter((p) => p.role === 'enricher')
  return { filters, waves: waveify(enrichers, edges) }
}

function topological(plugins: readonly Plugin[], edges: Map<string, Set<string>>): Plugin[] {
  const out: Plugin[] = []
  const placed = new Set<string>()
  let remaining = [...plugins]
  while (remaining.length) {
    const ready = remaining.filter((p) => [...(edges.get(p.name) ?? [])].every((d) => placed.has(d)))
    if (!ready.length) {
      const stuck = remaining
        .map((p) => p.name)
        .sort()
        .join(' -> ')
      throw new PluginError('E_PLUGIN_CYCLE', remaining[0]?.name ?? '?', `ordering is circular: ${stuck}`)
    }
    ready.sort((a, b) => a.name.localeCompare(b.name))
    for (const plugin of ready) {
      placed.add(plugin.name)
      out.push(plugin)
    }
    const done = new Set(ready.map((p) => p.name))
    remaining = remaining.filter((p) => !done.has(p.name))
  }
  return out
}

function waveify(plugins: readonly Plugin[], edges: Map<string, Set<string>>): Plugin[][] {
  const names = new Set(plugins.map((p) => p.name))
  const waves: Plugin[][] = []
  const placed = new Set<string>()
  let remaining = [...plugins]
  while (remaining.length) {
    const ready = remaining.filter((p) =>
      [...(edges.get(p.name) ?? [])].filter((d) => names.has(d)).every((d) => placed.has(d)),
    )
    if (!ready.length) {
      throw new PluginError('E_PLUGIN_CYCLE', remaining[0]?.name ?? '?', 'enricher ordering is circular')
    }
    for (const plugin of ready) placed.add(plugin.name)
    waves.push(ready)
    const done = new Set(ready.map((p) => p.name))
    remaining = remaining.filter((p) => !done.has(p.name))
  }
  return waves
}

/**
 * Declared reads, enforced reads. A plugin that touches request state it did not declare
 * throws rather than quietly tainting nothing, because the effect graph has to stay honest.
 */
export function guardReads(plugin: Plugin, ctx: EnvelopeContext): EnvelopeContext {
  const declared = new Set(plugin.reads ?? [])
  const check = (read: string): void => {
    if (!declared.has(read)) {
      throw new PluginError(
        'E_PLUGIN_UNDECLARED_READ',
        plugin.name,
        `read ${read} without declaring it. Add it to reads: [...]`,
      )
    }
  }
  return {
    ...ctx,
    flag: (name) => (check(`flag:${name}`), ctx.flag(name)),
    cookie: (key) => (check(`cookie:${key}`), ctx.cookie(key)),
    header: (key) => (check(`header:${key}`), ctx.header(key)),
    param: (key) => (check(`route:${key}`), ctx.param(key)),
    query: (key) => (check(`route:${key}`), ctx.query(key)),
    locale: () => (check('locale'), ctx.locale()),
    device: () => (check('device'), ctx.device()),
    user: () => (check('identity'), ctx.user()),
    now: () => (check('time'), ctx.now()),
  }
}

export interface PluginRunResult {
  provided: Record<string, unknown>
  /** Set when a filter ended the request. */
  response?: Response
  /** Non-critical plugins that failed. Reported, never fatal. */
  skipped: { plugin: string; reason: string }[]
  axes: Record<string, string[]>
}

export async function runPlugins(schedule: PluginSchedule, ctx: EnvelopeContext): Promise<PluginRunResult> {
  const provided: Record<string, unknown> = {}
  const skipped: { plugin: string; reason: string }[] = []
  const axes: Record<string, string[]> = {}

  for (const plugin of [...schedule.filters, ...schedule.waves.flat()]) {
    for (const [axis, values] of Object.entries(plugin.planAxis?.() ?? {})) axes[axis] = values
  }

  const invoke = async (plugin: Plugin): Promise<PluginResult | void> => {
    if (!plugin.onRequest) return
    const guarded = guardReads(plugin, ctx)
    try {
      return await withTimeout(plugin, () => Promise.resolve(plugin.onRequest?.(guarded, provided)))
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
