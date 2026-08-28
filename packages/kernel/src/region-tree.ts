import { createBinaryDecoder, encodeStream, num, type AnyFrame } from '@weftjs/warp'
import type { Ports, RegionBinding } from './ports.ts'
import type { RegionAnnouncement, RegionOutcome } from './region.ts'
import { announceRegion, readRegion, RegionError } from './region.ts'

/** The executor name a plan uses for a region it has not resolved yet, repeated here — `@weftjs/plan` depends on the kernel, not the other way round. */
const REGION_EXECUTOR = 'region'

/** How many tiers a probe walks before it stops asking. See `probeRegions`. */
export const PROBE_DEPTH = 8

/**
 * A composite's regions as a graph rather than as a total. `hops` answers "how much latency"; this
 * answers "made of what". Its own file: the request path never sees one — a region announces its
 * subtree only when `weft verify --probe` asks. See `spec/kernel/composition.md`.
 */
export interface RegionNode {
  region: string
  /** Where it ran, as the registry that resolved it named it — its registry, not this deployment's. */
  executor: string
  /** Boundaries crossed to reach it, and everything under it. */
  hops: number
  revision?: string
  /** `id@version`, as it was announced rather than as a shell expected. */
  contract?: string
  /** The code it degraded with. A graph with a hole in it says which hole. */
  failed?: string
  children?: readonly RegionNode[]
}

/**
 * How far a tree may go before it is a tree somebody is making up. Refused rather than truncated: a
 * graph silently cut off at the interesting level reads as complete.
 */
const MAX_DEPTH = 8
const MAX_NODES = 256

/**
 * Read a subtree out of what a region announced, and check it against what the same frame counted.
 * Every node is one deployment's claim about another, so what is checked is shape and arithmetic —
 * `hops` was previously unverifiable and a mismatch now refuses.
 */
export function readRegionTree(region: string, bytes: Uint8Array): readonly RegionNode[] {
  const first = decodeFirst(region, bytes)
  if (!first?.body) return []
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder().decode(first.body))
  } catch (error) {
    throw new RegionError(
      'E_REGION_TREE',
      region,
      `sent a subtree that is not JSON: ${(error as Error).message}`,
    )
  }

  let seen = 0
  const nodes = (input: unknown, depth: number): readonly RegionNode[] => {
    if (!Array.isArray(input)) {
      throw new RegionError('E_REGION_TREE', region, 'sent a subtree that is not a list of regions')
    }
    if (depth > MAX_DEPTH) {
      throw new RegionError(
        'E_REGION_TREE',
        region,
        `sent a subtree more than ${MAX_DEPTH} tiers deep. A page assembled through that many ` +
          `deployments has a problem this graph cannot report its way out of`,
      )
    }
    return input.map((entry) => {
      seen += 1
      if (seen > MAX_NODES) {
        throw new RegionError('E_REGION_TREE', region, `sent a subtree of more than ${MAX_NODES} regions`)
      }
      const node = (entry ?? {}) as Record<string, unknown>
      if (typeof node['region'] !== 'string' || typeof node['executor'] !== 'string') {
        throw new RegionError('E_REGION_TREE', region, 'sent a subtree entry naming no region or no executor')
      }
      const hops = node['hops']
      if (typeof hops !== 'number' || !Number.isFinite(hops) || hops < 0) {
        throw new RegionError(
          'E_REGION_TREE',
          region,
          `sent '${node['region']}' with a hop count of '${String(hops)}'`,
        )
      }
      return {
        region: node['region'],
        executor: node['executor'],
        hops,
        ...(typeof node['revision'] === 'string' ? { revision: node['revision'] } : {}),
        ...(typeof node['contract'] === 'string' ? { contract: node['contract'] } : {}),
        ...(typeof node['failed'] === 'string' ? { failed: node['failed'] } : {}),
        ...(node['children'] === undefined ? {} : { children: nodes(node['children'], depth + 1) }),
      }
    })
  }

  const tree = nodes(value, 1)
  const total = treeHops(tree)
  const counted = num(first, 'hops') ?? 0
  if (total !== counted) {
    throw new RegionError(
      'E_REGION_TREE',
      region,
      `announced ${counted} hop(s) and a tree crossing ${total}. The number is what a plan's ` +
        `ceiling was checked against, so the two cannot disagree`,
    )
  }
  return tree
}

/**
 * The `REGION` frame out of an answer, decoded here rather than handed over by `readRegion` — a
 * second decode, but one that runs once per region at deploy time, keeping the request path free
 * of this code.
 */
function decodeFirst(region: string, bytes: Uint8Array): AnyFrame | undefined {
  try {
    const decoder = createBinaryDecoder({ expect: 'down' })
    const frames = decoder.push(bytes)
    decoder.end()
    return frames[0]
  } catch (error) {
    throw new RegionError(
      'E_REGION_UNREADABLE',
      region,
      `its frames could not be read, so nothing it sent may reach the page — ${(error as Error).message}`,
    )
  }
}

/** What a region answers with when it was asked what it is rather than for a page. A leaf answers with no body: "composes nothing". */
export function regionProbeStream(announcement: RegionAnnouncement, tree: readonly RegionNode[]): Uint8Array {
  const first = announceRegion(announcement)
  const body = encodeRegionTree(tree)
  return new Uint8Array(encodeStream([body ? { ...first, body, bodyIsText: true } : first]))
}

/** What a region says about itself when it composed nothing: the empty tree, and its own count. */
export function encodeRegionTree(tree: readonly RegionNode[]): Uint8Array | undefined {
  if (!tree.length) return undefined
  return new TextEncoder().encode(JSON.stringify(tree))
}

/** Every boundary a tree crosses, which is the number that goes in the announcement beside it. */
export function treeHops(tree: readonly RegionNode[]): number {
  return tree.reduce((n, node) => n + node.hops, 0)
}

/**
 * One outcome as a node: what a tier's own render actually composed. One level, deliberately — a
 * render carries the count rather than a subtree, and the count is **measured**.
 */
export function regionNode(outcome: RegionOutcome): RegionNode {
  return {
    region: outcome.region,
    executor: outcome.executor,
    hops: outcome.hops,
    ...(outcome.revision ? { revision: outcome.revision } : {}),
    ...(outcome.failure ? { failed: outcome.failure.code } : {}),
  }
}

/** Every region a composer composed, as the graph to hand to whoever asked. */
export function regionGraph(composed: readonly RegionOutcome[]): readonly RegionNode[] {
  return composed.map(regionNode)
}

/** A graph as something a person reads. Indented rather than boxed: the depth is the point. */
export function formatRegionGraph(tree: readonly RegionNode[], indent = '    '): string {
  const lines: string[] = []
  const walk = (nodes: readonly RegionNode[], prefix: string): void => {
    nodes.forEach((node, i) => {
      const last = i === nodes.length - 1
      const where = node.failed ? `${node.executor}  ${node.failed}` : node.executor
      const detail = [
        `${node.hops} hop${node.hops === 1 ? '' : 's'}`,
        node.contract ?? '',
        node.revision ? `rev ${node.revision}` : '',
      ]
        .filter(Boolean)
        .join('  ')
      lines.push(`${prefix}${last ? '└─' : '├─'} ${node.region.padEnd(16)}${where.padEnd(20)}${detail}`)
      if (node.children?.length) walk(node.children, `${prefix}${last ? '   ' : '│  '}`)
    })
  }
  walk(tree, indent)
  return lines.join('\n')
}

/**
 * A probe that asks a region what it is serving, through the executor the registry named — the
 * composition path, not a second one, so a passing verification verifies what will actually serve
 * traffic.
 */
/** What asking needs: somewhere to run and, for the recursive half, something to resolve a name. */
export type ProbePorts = Pick<Ports, 'registry' | 'executors'>

/** Ask every region what it is actually serving, so `weft verify` can fail on a disagreement. */
export function regionProbe(
  ports: Pick<Ports, 'executors'>,
  depth = PROBE_DEPTH,
): (binding: RegionBinding) => Promise<Uint8Array> {
  return async (binding) => {
    const executor = ports.executors[binding.executor]
    if (!executor) {
      throw new Error(`E_UNKNOWN_EXECUTOR: '${binding.executor}' is not bound, so nothing can ask`)
    }
    const outcome = await executor.run({
      slot: binding.region,
      ...(binding.address ? { address: { ...binding.address, props: { probe: { depth } } } } : {}),
      run: () => Promise.reject(new Error('E_REGION_NOT_LOCAL: a probe does not render here')),
    })
    if (outcome.failure) throw new Error(`${outcome.failure.code}: ${outcome.failure.message}`)
    return outcome.bytes
  }
}

/**
 * The recursive half: what a deployment answers when *it* is the region being probed — its whole
 * subtree, resolved through its own registry, one depth cheaper than asked. A region that cannot be
 * reached becomes a node saying so rather than an exception.
 */
export async function probeRegions(
  ports: ProbePorts,
  regions: readonly string[],
  depth: number = PROBE_DEPTH,
): Promise<readonly RegionNode[]> {
  const registry = ports.registry
  const ask = regionProbe(ports, Math.max(0, depth - 1))
  const out: RegionNode[] = []

  for (const region of regions) {
    if (depth <= 0) {
      // The bound, as a node: a graph that stopped silently would read as complete.
      out.push({ region, executor: 'unresolved', hops: 0, failed: 'E_REGION_TOO_DEEP' })
      continue
    }
    const binding = await registry?.region?.(region)
    if (!binding) {
      out.push({ region, executor: 'unresolved', hops: 0, failed: 'E_NO_SUCH_REGION' })
      continue
    }
    const remote = binding.executor !== 'inline' && binding.executor !== REGION_EXECUTOR
    try {
      const bytes = await ask(binding)
      const answer = readRegion(region, bytes, undefined)
      const children = readRegionTree(region, bytes)
      const said = answer.announced
      out.push({
        region,
        executor: binding.executor,
        hops: (remote ? 1 : 0) + said.hops,
        ...((said.revision ?? binding.revision)
          ? { revision: (said.revision ?? binding.revision) as string }
          : {}),
        ...(said.contract ? { contract: `${said.contract.id}@${said.contract.version}` } : {}),
        ...(children.length ? { children } : {}),
      })
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'E_REGION_UNREACHABLE'
      out.push({ region, executor: binding.executor, hops: remote ? 1 : 0, failed: code })
    }
  }
  return out
}
