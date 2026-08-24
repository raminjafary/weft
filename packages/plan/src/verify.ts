import { readRegion, type Ports, type RegionBinding, type Registry } from '@weft/kernel'
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

export interface RegionStatus {
  region: string
  route: string
  declared: 'local' | 'remote'
  /** What the registry says, when it has an entry. */
  bound?: RegionBinding
  /** What the region answered when it was asked, for a verification that probes. */
  serving?: { contract?: string; revision?: string; reads?: readonly string[] }
  issues: Issue[]
}

export interface VerifyReport {
  regions: RegionStatus[]
  errors: Issue[]
  warnings: Issue[]
  text: string
}

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
        const announced = readRegion(spec.name, await probe(binding), undefined)
        status.serving = {
          ...(announced.announced.contract
            ? { contract: `${announced.announced.contract.id}@${announced.announced.contract.version}` }
            : {}),
          ...(announced.announced.revision ? { revision: announced.announced.revision } : {}),
          ...(announced.announced.contract?.reads ? { reads: announced.announced.contract.reads } : {}),
        }
        const expected = decl.contract
        if (expected) {
          const serving = announced.announced.contract
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
  return { regions, errors, warnings: [], text: format(regions) }
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

/**
 * A probe that asks a region what it is serving, through the executor the registry named.
 *
 * It is the composition path and not a second one: the same executor, the same address, the same
 * announcement — so a verification that passes is a verification of the thing that will actually
 * serve traffic. What it deliberately does not do is render: the request carries no route and no
 * params, because a region asked what it is has not been asked for a page.
 */
export function regionProbe(ports: Ports): (binding: RegionBinding) => Promise<Uint8Array> {
  return async (binding) => {
    const executor = ports.executors[binding.executor]
    if (!executor) {
      throw new Error(`E_UNKNOWN_EXECUTOR: '${binding.executor}' is not bound, so nothing can ask`)
    }
    const outcome = await executor.run({
      slot: binding.region,
      ...(binding.address ? { address: { ...binding.address, props: { probe: true } } } : {}),
      run: () => Promise.reject(new Error('E_REGION_NOT_LOCAL: a probe does not render here')),
    })
    if (outcome.failure) throw new Error(`${outcome.failure.code}: ${outcome.failure.message}`)
    return outcome.bytes
  }
}
