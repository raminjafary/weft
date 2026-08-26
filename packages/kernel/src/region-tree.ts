import { createBinaryDecoder, encodeStream, num, type AnyFrame } from '@weft/warp'
import type { Ports, RegionBinding } from './ports.ts'
import type { RegionAnnouncement, RegionOutcome } from './region.ts'
import { announceRegion, readRegion, RegionError } from './region.ts'

/**
 * The executor name a plan uses for a region it has not resolved yet, repeated here rather than
 * imported: `@weft/plan` depends on the kernel and not the other way round, and one string is a
 * better price than an edge in the wrong direction. `spec/plan/regions.md` is where it is defined.
 */
const REGION_EXECUTOR = 'region'

/** How many tiers a probe walks before it stops asking. See `probeRegions`. */
export const PROBE_DEPTH = 8

/**
 * A composite's regions as a graph rather than as a total, and the one module that knows the shape.
 *
 * A region's own regions are resolved by its own registry — that is what the registry being a port
 * buys, and it is right. What it left behind was a **number**: a composite could report that it
 * crossed three boundaries and nothing could say which three, or where the third one was, or whether
 * a page's fallback came from the region it named or from something two tiers behind it. `hops` is
 * the answer to "how much latency"; this is the answer to "made of what".
 *
 * **Why it is a file of its own and not part of `region.ts`.** The request path never sees one. A
 * region announces its subtree when something *asks* what the topology is — `weft verify --probe`,
 * and nothing else — so `readRegion` keeps the bytes and stops there, and the parser below is
 * imported by the verifier and by a region service answering a probe. Composition got its own entry
 * on the rule that a deployment which composes nothing should not carry the check that makes
 * composing safe; this is the same rule applied one level in, and it is the difference between 18
 * bytes of headroom on that entry and none.
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
 * How far a tree may go before it is a tree somebody is making up.
 *
 * These are the only two numbers here that are not somebody else's claim. A subtree is the one thing
 * a region sends whose size it chooses, and a composite that walked an arbitrarily deep one on the
 * strength of a length prefix would be doing what every parser that trusted a nesting depth has
 * done. Refused rather than truncated: a graph silently cut off at the interesting level is worse
 * than no graph, because it reads as complete.
 */
const MAX_DEPTH = 8
const MAX_NODES = 256

/**
 * Read a subtree out of what a region announced, and check it against what the same frame counted.
 *
 * Nothing in a tree is verifiable from here — every node is one deployment's claim about another
 * deployment — so what is checked is the shape and the arithmetic. The arithmetic matters more than
 * it looks: `hops` was the whole of what a nested tier reported and therefore could not be
 * contradicted, and a total that does not add up is now either a tier miscounting its own boundaries
 * or a tree describing a topology other than the one that answered. Both are worth refusing, because
 * the count is what a plan's ceiling and a route's latency budget were checked against.
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
 * The `REGION` frame out of an answer, decoded here rather than handed over by `readRegion`.
 *
 * A second decode of the same bytes, and worth being plain about why it is not wasteful: this runs
 * at deploy time, once per region, on a command that has already made a network round trip to get
 * these bytes. What it buys is that the request path — which will never see a subtree — carries no
 * line of code for one. `readRegion` still does every check that matters before any of this is
 * looked at; the caller runs it first, and this only reaches for the part it left behind.
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

/**
 * What a region answers with when it was asked what it is rather than for a page.
 *
 * The one place the body form of a `REGION` frame is written, matching the one place it is read.
 * A leaf answers with no body at all, which is a real answer — "composes nothing" — and costs the
 * bytes it should.
 */
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
 * One outcome as a node: what a tier's own render actually composed.
 *
 * One level, and deliberately. A region reports its subtree when it is *asked what it is* — the
 * probe path, where a graph is the answer — and a render carries the count instead, because a
 * composite has no parser for a subtree on the request path and would be forwarding bytes nobody
 * reads. What this is for is the count being **measured**: a service that composed three regions
 * and lost one to a timeout announces the boundaries it crossed rather than the ones its
 * configuration said it usually crosses.
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

/**
 * A graph as something a person reads, which is the whole reason it exists.
 *
 * Indented rather than boxed: the depth is the point, and a table cannot show depth without a column
 * per tier. Each line says where it ran and what it cost, and a degraded region says so on its own
 * line rather than in a footnote — a hole in a page is a fact about the graph.
 */
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
 * A probe that asks a region what it is serving, through the executor the registry named.
 *
 * It is the composition path and not a second one: the same executor, the same address, the same
 * announcement — so a verification that passes is a verification of the thing that will actually
 * serve traffic. What it deliberately does not do is render: the request carries no route and no
 * params, because a region asked what it is has not been asked for a page.
 */
/**
 * What asking needs: somewhere to run and, for the recursive half, something to resolve a name.
 *
 * Narrower than `Ports` because a region composing regions is not a deployment with a session and a
 * store — it is a registry and an executor, which is the same reduction `createComposer` makes.
 */
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
 * The recursive half: what a deployment answers when *it* is the region being probed.
 *
 * A region service that composes regions of its own implements `probe` with this, and what it hands
 * back is its whole subtree — resolved through its own registry, over its own executors, one depth
 * cheaper than it was asked. That is the only arrangement in which a composite tree can be reported
 * as one graph: nobody in the chain can resolve anybody else's names, so each tier answers for
 * itself and the tier above splices.
 *
 * A region that cannot be reached becomes a node saying so rather than an exception, for the reason
 * the whole tier boundary exists: one region being down is a hole in a page, and a verification that
 * threw would report nothing about the other four.
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
      // The bound, as a node. A graph that stopped without saying it stopped would read as complete.
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
