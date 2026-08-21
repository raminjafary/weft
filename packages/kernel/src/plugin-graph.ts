import { PluginError, type Plugin, type PluginSchedule } from './plugins.ts'

/**
 * Build-time, and deliberately not in the request path. The dependency graph is inferred
 * rather than declared: `reads` and `provides` give the kernel everything it needs, so B
 * reads what A provides and the edge exists without anybody writing `after: ['A']`.
 * Hand-declared edges stay for the cases data flow cannot express — a CSP nonce must be
 * injected before analytics adds a script tag, and no read/write relationship captures that.
 *
 * Nothing here depends on a request. Resolve the schedule once, hand it to `createKernel`,
 * and the sort, the cycle check and the ambiguity check are all paid for before the process
 * serves anything.
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
  const axes: Record<string, string[]> = {}
  for (const plugin of order) {
    for (const [axis, values] of Object.entries(plugin.planAxis?.() ?? {})) axes[axis] = values
  }
  return { filters, waves: waveify(enrichers, edges), axes }
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

/** An empty schedule, for a kernel with no plugins at all. */
export const NO_PLUGINS: PluginSchedule = { filters: [], waves: [], axes: {} }
