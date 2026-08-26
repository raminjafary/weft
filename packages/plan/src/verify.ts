import { readRegion, readRegionTree, type RegionBinding, type RegionNode, type Registry } from '@weft/kernel'
import { REGION_EXECUTOR, type Plan } from './dsl.ts'
import type { Issue } from './validate.ts'

/**
 * The checks a build cannot do, run where the answers exist.
 *
 * A plan says a region is remote; a registry says where it is; a deployment says which executors it
 * binds; the region itself says what it is serving. Those are four facts in four places, and every
 * pair of them can disagree — so this compares them at the two moments where the information is
 * actually available.
 *
 * **At startup**, against the registry: a region nothing resolves, a registry entry naming an
 * executor nobody bound, a plan and a registry that disagree about whether a region crosses a
 * boundary at all. None of these is knowable at build time, because a registry is a deployment's
 * and can be written to without anybody rebuilding.
 *
 * **Against what is running**, by asking: the region answers with the contract it is serving now,
 * which is the window CI cannot close. A contract test against a published type says what was true
 * when the type was published. This says what is true at the moment of the deploy.
 */
export interface VerifyContext {
  registry?: Registry
  /** Executor names this deployment binds. */
  executors?: readonly string[]
}

/** What one region says it is serving right now, against what this build expected. */
export interface RegionStatus {
  region: string
  route: string
  declared: 'local' | 'remote'
  /** What the registry says, when it has an entry. */
  bound?: RegionBinding
  /** What the region answered when it was asked, for a verification that probes. */
  serving?: { contract?: string; revision?: string; reads?: readonly string[] }
  /** What it said it composes in turn. Empty for a leaf; absent for a region nobody asked. */
  tree?: readonly RegionNode[]
  issues: Issue[]
}

/**
 * One route's regions as a graph, which is the thing a hop count was standing in for.
 *
 * A plan can count the regions a route declares and it stops there, because what a region composes
 * is resolved by *its* registry and this deployment has never seen it. So the graph is assembled
 * from answers rather than from the plan: each tier is asked, each tier asks the tier below it, and
 * what comes back is spliced in where it was asked for.
 */
export interface RouteGraph {
  route: string
  regions: readonly RegionNode[]
  /** Every boundary this route crosses, through the whole tree rather than the first level of it. */
  hops: number
  /** What the plan counted, which sees only the regions the route itself declares. */
  declared: number
}

/** Every region probed, and whether any of them disagreed with the manifest. */
export interface VerifyReport {
  regions: RegionStatus[]
  errors: Issue[]
  warnings: Issue[]
  text: string
  /** Empty without `--probe`: a topology is what deployments answer, not what a plan says. */
  graph: readonly RouteGraph[]
}

/** Ask each region what it is serving. A disagreement is what `weft verify --probe` exits non-zero on. */
export async function verifyRegions(
  plans: readonly Plan[],
  context: VerifyContext,
  probe?: (binding: RegionBinding) => Promise<Uint8Array>,
): Promise<VerifyReport> {
  const regions: RegionStatus[] = []
  const bound = new Set(['inline', 'client', ...(context.executors ?? [])])

  for (const plan of plans) {
    for (const spec of plan.slots) {
      const decl = spec.region
      if (!decl) continue
      const status: RegionStatus = { region: spec.name, route: plan.route, declared: decl.locus, issues: [] }
      regions.push(status)

      if (!context.registry?.region) {
        status.issues.push({
          code: 'E_NO_REGION_REGISTRY',
          slot: spec.name,
          message: 'no registry able to resolve a region is bound, and a shell that composes one needs it',
        })
        continue
      }
      const binding = await context.registry.region(spec.name)
      if (!binding) {
        status.issues.push({
          code: 'E_NO_SUCH_REGION',
          slot: spec.name,
          message: `${plan.route} composes it and the ${context.registry.name} registry resolves no region by that name`,
        })
        continue
      }
      status.bound = binding

      const remote = binding.executor !== 'inline' && binding.executor !== REGION_EXECUTOR
      if (remote !== (decl.locus === 'remote')) {
        // Not a warning. A plan declared `remote` is a plan whose hop count, cache class and render
        // location were all decided on that basis, and a registry quietly making it local means
        // every one of those numbers describes a different deployment than the one running.
        status.issues.push({
          code: 'E_REGION_LOCUS_MISMATCH',
          slot: spec.name,
          message:
            `${plan.route} declares it ${decl.locus} and the registry binds it to '${binding.executor}'. ` +
            `The plan's hop count and the document's cache class were both derived from the declaration`,
        })
      }
      if (!bound.has(binding.executor)) {
        status.issues.push({
          code: 'E_UNKNOWN_EXECUTOR',
          slot: spec.name,
          message: `the registry binds it to '${binding.executor}', which this deployment does not bind`,
        })
      }
      if (decl.contract && binding.contract && binding.contract.version !== decl.contract.version) {
        status.issues.push({
          code: 'E_REGION_CONTRACT',
          slot: spec.name,
          message:
            `${plan.route} was built against ${decl.contract.id}@${decl.contract.version} and the ` +
            `registry points at ${binding.contract.id}@${binding.contract.version}`,
        })
      }

      if (!probe || !remote) continue
      try {
        const bytes = await probe(binding)
        const answer = readRegion(spec.name, bytes, undefined)
        const announced = answer.announced
        status.serving = {
          ...(announced.contract
            ? { contract: `${announced.contract.id}@${announced.contract.version}` }
            : {}),
          ...(announced.revision ? { revision: announced.revision } : {}),
          ...(announced.contract?.reads ? { reads: announced.contract.reads } : {}),
        }
        // What it composes in turn, as it resolved it. A leaf answers with an empty tree, which is a
        // different answer from a region that was never asked — hence a field rather than a length.
        status.tree = readRegionTree(spec.name, bytes)
        const expected = decl.contract
        if (expected) {
          const serving = announced.contract
          if (!serving || serving.id !== expected.id || serving.version !== expected.version) {
            status.issues.push({
              code: 'E_REGION_CONTRACT',
              slot: spec.name,
              message:
                `is serving ${serving ? `${serving.id}@${serving.version}` : 'no contract at all'} and ` +
                `${plan.route} was built against ${expected.id}@${expected.version}`,
            })
          } else if (expected.reads && !same(expected.reads, serving.reads ?? [])) {
            status.issues.push({
              code: 'E_REGION_CONTRACT',
              slot: spec.name,
              message:
                `is serving reads ${(serving.reads ?? []).join(', ') || '(none)'} and this shell derives ` +
                `a cache class and a Vary from ${[...expected.reads].sort().join(', ')}`,
            })
          }
        }
      } catch (error) {
        status.issues.push({
          code: 'E_REGION_UNREACHABLE',
          slot: spec.name,
          message: (error as Error).message,
        })
      }
    }
  }

  const errors = regions.flatMap((r) => r.issues)
  const graph = probe ? graphOf(plans, regions) : []
  const warnings = deeperThanPlanned(graph)
  return { regions, errors, warnings, text: format(regions), graph }
}

/**
 * The routes as trees, assembled out of what each tier answered about itself.
 *
 * Every node above the first level is spliced rather than resolved — a region two tiers down is a
 * name in somebody else's registry, and this deployment could not resolve it if it tried. That is
 * the property the graph is reporting, not a limitation of it.
 */
function graphOf(plans: readonly Plan[], regions: readonly RegionStatus[]): readonly RouteGraph[] {
  const out: RouteGraph[] = []
  for (const plan of plans) {
    const mine = regions.filter((status) => status.route === plan.route)
    if (!mine.length) continue
    const nodes = mine.map((status): RegionNode => {
      const remote = status.bound
        ? status.bound.executor !== 'inline' && status.bound.executor !== REGION_EXECUTOR
        : false
      const under = (status.tree ?? []).reduce((n, node) => n + node.hops, 0)
      const failure = status.issues.at(0)
      return {
        region: status.region,
        executor: status.bound?.executor ?? 'unresolved',
        hops: (remote ? 1 : 0) + under,
        ...((status.serving?.revision ?? status.bound?.revision)
          ? { revision: (status.serving?.revision ?? status.bound?.revision) as string }
          : {}),
        ...(status.serving?.contract ? { contract: status.serving.contract } : {}),
        ...(failure ? { failed: failure.code } : {}),
        ...(status.tree?.length ? { children: status.tree } : {}),
      }
    })
    out.push({
      route: plan.route,
      regions: nodes,
      hops: nodes.reduce((n, node) => n + node.hops, 0),
      declared: mine.filter((status) => status.declared === 'remote').length,
    })
  }
  return out
}

/**
 * The one thing a graph can say that a plan cannot, said as a warning rather than left in a picture.
 *
 * `hopsOf(plan)` counts the regions a route declares, which is every boundary it can see: what a
 * region composes is resolved by that region's registry, so a tier two deep is invisible to the
 * build and to the ceiling the build checked. A route that turns out to cross more boundaries than
 * it was planned to cross is not wrong — a region is entitled to compose regions, and this
 * deployment does not own that decision — but it is the number the latency budget was written
 * against, and finding it out from a graph is better than finding it out under load.
 */
function deeperThanPlanned(graph: readonly RouteGraph[]): Issue[] {
  const out: Issue[] = []
  for (const route of graph) {
    if (route.hops <= route.declared) continue
    const nested = route.regions.filter((node) => node.children?.length)
    out.push({
      code: 'W_REGION_TREE_DEEPER',
      slot: nested.map((node) => node.region).join(', ') || route.route,
      message:
        `${route.route} crosses ${route.hops} boundaries and its plan counted ${route.declared}: ` +
        `${nested.map((node) => `${node.region} composes ${(node.children ?? []).map((child) => child.region).join(', ')}`).join('; ')}. ` +
        `A region composing regions is its own deployment's decision, and the ceiling this route was ` +
        `checked against did not know about it`,
    })
  }
  return out
}

function same(a: readonly string[], b: readonly string[]): boolean {
  const left = [...a].sort()
  const right = [...b].sort()
  return left.length === right.length && left.every((read, i) => read === right[i])
}

function format(regions: readonly RegionStatus[]): string {
  if (!regions.length) return '  no route composes a region\n'
  const lines: string[] = []
  for (const status of regions) {
    const where = status.bound ? status.bound.executor : 'unresolved'
    const serving = status.serving?.contract ?? (status.declared === 'local' ? 'local' : 'not asked')
    lines.push(
      `  ${status.route.padEnd(18)}${status.region.padEnd(16)}${status.declared.padEnd(8)}` +
        `${where.padEnd(20)}${serving}${status.serving?.revision ? `  rev ${status.serving.revision}` : ''}`,
    )
    for (const issue of status.issues) lines.push(`      ${issue.code}: ${issue.message}`)
  }
  return `${lines.join('\n')}\n`
}
