import type { JobAddress, RegionBinding, RegionContract } from '@weftjs/kernel'
import { bindingExecutor, svcExecutor, type BoundFetch } from './remote-executors.ts'
import { manifestRegistry, type ManifestRegistry } from './registry.ts'
import type { KernelExecutor } from '@weftjs/kernel'

/**
 * The design's four named topologies, as configuration rather than as modes.
 *
 * The claim being implemented is "same build output, four deployment shapes", and the honest form
 * of it is smaller than four mechanisms: every one of these produces a registry and a set of
 * executors, and nothing above the registry can tell which it got. `describe()` says which one is
 * in force, because a deployment shape that cannot be printed is a deployment shape somebody will
 * guess at during an incident.
 *
 * Two of the four are the same code with a different address, and saying so is better than
 * inventing a distinction: `edge-regional` is `split-render` whose render tier is somewhere else.
 * The difference is real — a regional tier is near the database and the gateway is not — and it is
 * a URL rather than a topology, so this function does not pretend otherwise.
 */
export type TopologyName = 'monolith' | 'split-render' | 'edge-regional' | 'mesh'

/** One region in a named topology: what serves it, and at what revision. */
export interface TopologyRegion {
  region: string
  /** Module and export on the far side. Required by every shape except the monolith. */
  address?: JobAddress
  /** Where this region's own service is, for `mesh`. */
  url?: string
  /** A binding, for a platform where one tier reaches another without a network. */
  binding?: BoundFetch
  contract?: RegionContract
  revision?: string
}

/** What a topology needs: its regions, and how each one is reached. */
export interface TopologyOptions {
  regions: readonly TopologyRegion[]
  /**
   * The one render tier `split-render` and `edge-regional` send every region to. A URL for a pod,
   * a binding for a platform that has them.
   */
  render?: { url?: string; binding?: BoundFetch; timeoutMs?: number }
  /** Applied to every remote region. A deadline on waiting, which is what a boundary can promise. */
  timeoutMs?: number
}

/** A named arrangement of regions across deployments, and the registry that resolves it. */
export interface Topology {
  name: TopologyName
  registry: ManifestRegistry
  executors: Record<string, KernelExecutor>
  /** One line per region: where it runs and what reaches it. What an incident needs. */
  describe(): string
}

/** One of the design's named topologies, built so switching between them is a config change. */
export function topology(name: TopologyName, options: TopologyOptions): Topology {
  const executors: Record<string, KernelExecutor> = {}
  const bindings: RegionBinding[] = []

  const tier = (label: string, where: { url?: string; binding?: BoundFetch; timeoutMs?: number }) => {
    if (executors[label]) return label
    if (where.binding) {
      executors[label] = bindingExecutor({
        binding: where.binding,
        name: label,
        ...(where.timeoutMs !== undefined ? { timeoutMs: where.timeoutMs } : {}),
      })
      return label
    }
    if (!where.url) {
      throw new Error(
        `E_NO_TIER: topology '${name}' needs somewhere to send '${label}' — a url or a binding. A ` +
          `topology that quietly collapsed to this process would be a monolith reported as a split`,
      )
    }
    executors[label] = svcExecutor({
      url: where.url,
      name: label,
      ...(where.timeoutMs !== undefined ? { timeoutMs: where.timeoutMs } : {}),
    })
    return label
  }

  for (const region of options.regions) {
    if (name === 'monolith') {
      bindings.push({ region: region.region, executor: 'inline', ...contractOf(region) })
      continue
    }
    if (!region.address) {
      throw new Error(
        `E_NO_REGION_ADDRESS: region '${region.region}' crosses a boundary in topology '${name}' and ` +
          `names no module and export. A closure does not cross a crash domain`,
      )
    }
    const label =
      name === 'mesh'
        ? tier(`svc:${region.region}`, {
            ...(region.url !== undefined ? { url: region.url } : {}),
            ...(region.binding ? { binding: region.binding } : {}),
            ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          })
        : tier(name === 'edge-regional' ? 'svc:regional' : 'binding:render', {
            ...options.render,
            ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          })
    bindings.push({
      region: region.region,
      executor: label,
      address: region.address,
      ...contractOf(region),
    })
  }

  const registry = manifestRegistry([], { regions: bindings })
  return {
    name,
    registry,
    executors,
    describe: () =>
      [
        `topology ${name}`,
        ...bindings.map(
          (b) =>
            `  ${b.region.padEnd(18)}${b.executor.padEnd(20)}` +
            `${b.contract ? `${b.contract.id}@${b.contract.version}` : 'no contract'}` +
            `${b.revision ? `  rev ${b.revision}` : ''}`,
        ),
      ].join('\n'),
  }
}

function contractOf(region: TopologyRegion): Partial<RegionBinding> {
  return {
    ...(region.contract ? { contract: region.contract } : {}),
    ...(region.revision ? { revision: region.revision } : {}),
  }
}
