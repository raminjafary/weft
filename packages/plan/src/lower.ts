import {
  createSegmentMemo,
  render as renderTemplate,
  renderIncremental,
  type SegmentMemo,
  type Resolver,
  type TemplateIR,
  unionEffects,
  type Values,
} from '@weftjs/ir'
import {
  chainSplitter,
  createComposer,
  readsFor,
  regionEffects,
  regionStream,
  type CachePolicy,
  type EnvelopeContext,
  type JobAddress,
  type KernelRoute,
  type KernelSlot,
  type Order,
  type Ports,
  type PreloadLink,
  type RegionRequest,
  type RegionSpec,
  type RenderPort,
  type RenderContext,
  type RouteResolver,
} from '@weftjs/kernel'
import { PlanError, type CacheSpec, type Plan, type RegionDecl, type SlotSpec } from './dsl.ts'
import { assertPlan, cspOf, type ValidateContext } from './validate.ts'

/** The seam: a plan and some compiled fragments become a route. See `spec/kernel/routing.md`. */
export interface FragmentSource {
  entry: TemplateIR
  /** Nested row and component templates, by version. */
  resolve?(version: string): TemplateIR | undefined
}

/**
 * What a slot renders with. It runs in phase B, so its context has the read surface and no
 * envelope methods — which is why this signature can hand it `ctx` at all.
 */
export type SlotValues = (ctx: RenderContext, params: Record<string, string>) => Values | Promise<Values>

/** What actually renders a slot: the fragment, its values, and where it can be reached by name. */
export interface SlotBinding {
  fragment: FragmentSource
  values: SlotValues
  /** Rendered when the slot degrades. Without one a degraded slot is empty, which is honest. */
  placeholder?: Uint8Array
  /** Where this slot's render can be reached by name, for an executor a closure cannot go to. `E_SLOT_NOT_ADDRESSABLE` if missing. */
  address?: JobAddress
}

/**
 * A guard runs in phase A by construction, which is the whole reason guards are a plan-level
 * declaration. Returning false applies the declared redirect or status — a real one, on a
 * response whose envelope is still open.
 */
export type GuardHandler = (ctx: EnvelopeContext) => boolean | Promise<boolean>

/** The bytes-producers behind a plan. The plan says what; this says with what. */
export interface RouteBindings {
  shell: FragmentSource
  /** Layouts nested inside `shell`, outermost first, matching `plan.shellChain`. Disagreement is `E_SHELL_CHAIN_MISMATCH`. */
  nested?: readonly (FragmentSource & { at: string })[]
  /** The shell's non-slot values, a function of matched params only. See `spec/kernel/routing.md`. */
  shellValues?(params: Record<string, string>): Values | Promise<Values>
  slots: Record<string, SlotBinding>
  guards?: Record<string, GuardHandler>
  /** Phase A work beyond the guards. */
  envelope?(ctx: EnvelopeContext): void | Promise<void>
  critical?: PreloadLink[]
  /** Overrides the order derived from the plan's slot deliveries. */
  order?: Order
  /** Who turns this route's fragments into bytes. Without one, the IR renderer is called directly. An `.incremental()` slot renders through its own memo either way. See `spec/kernel/ports.md`. */
  render?: RenderPort
  /** What this route's regions are composed against. Required only by a plan that declares one. See `spec/kernel/composition.md`. */
  regions?: RegionBindings
}

/** What a region needs beyond a slot: the ports, the request, and the bytes behind its degradation. */
export interface RegionBindings {
  ports: Ports
  /** What a region is told beyond the route and its params. A function of the params: a closure cannot survive the serialisation. */
  request?(params: Record<string, string>): RegionRequest
  /** The bytes behind a region's declared degradation, by region name — not the slot binding, since a remote region has none. */
  degraded?: Record<string, { fallback?: Uint8Array; placeholder?: Uint8Array }>
}

function policyOf(spec: CacheSpec | undefined): CachePolicy | undefined {
  if (!spec) return undefined
  return {
    class: spec.class,
    ...(spec.ttlMs !== undefined ? { ttlMs: spec.ttlMs } : {}),
    ...(spec.staleWhileRevalidateMs !== undefined
      ? { staleWhileRevalidateMs: spec.staleWhileRevalidateMs }
      : {}),
    ...(spec.tags ? { tags: spec.tags } : {}),
  }
}

/** `out-of-order` the moment any slot asks to stream, `in-order` when none does. See `spec/kernel/routing.md`. */
function orderOf(plan: Plan): Order {
  return plan.slots.some((s) => s.delivery === 'stream') ? 'out-of-order' : 'in-order'
}

/**
 * `.incremental()`: level three memoisation, one content-addressed memo per slot per lowered
 * route. See `spec/kernel/surgical.md`. `previous` is not carried across requests here — two
 * consecutive requests are usually two different users, and level three does not need it.
 */
function incrementalRender(fragment: FragmentSource, memo: SegmentMemo): (values: Values) => Uint8Array {
  return (values) =>
    renderIncremental({
      ir: fragment.entry,
      values,
      memo,
      ...(fragment.resolve ? { resolve: fragment.resolve } : {}),
    }).bytes
}

/** How a slot's values become bytes: its own memo when incremental, the render port when bound, the IR renderer otherwise. */
function paintOf(
  spec: SlotSpec,
  binding: SlotBinding,
  renderer?: RenderPort,
): (values: Values) => Uint8Array | Promise<Uint8Array> {
  const { fragment } = binding
  const memo = spec.incremental ? createSegmentMemo() : null
  if (memo) return incrementalRender(fragment, memo)
  if (renderer) {
    return (values: Values) =>
      renderer.render({
        slot: spec.name,
        template: fragment.entry,
        values,
        ...(fragment.resolve ? { resolve: fragment.resolve } : {}),
      })
  }
  return (values: Values) => renderTemplate(fragment.entry, values, fragment.resolve)
}

function slotOf(
  spec: SlotSpec,
  binding: SlotBinding,
  params: Record<string, string>,
  renderer?: RenderPort,
): KernelSlot {
  const { fragment } = binding
  const policy = policyOf(spec.cache)
  const paint = paintOf(spec, binding, renderer)
  return {
    name: spec.name,
    id: fragment.entry.id,
    version: fragment.entry.version,
    effects: fragment.entry.effects,
    needs: [...spec.needs],
    prio: spec.prio,
    executor: spec.executor,
    ...(spec.budget?.cpuMs !== undefined ? { cpuBudgetMs: spec.budget.cpuMs } : {}),
    ...(spec.budget?.onExceed ? { onExceed: spec.budget.onExceed } : {}),
    ...(policy ? { policy } : {}),
    ...(binding.placeholder ? { placeholder: binding.placeholder } : {}),
    ...(binding.address ? { address: binding.address } : {}),
    render: async (ctx) => paint(await binding.values(ctx, params)),
  }
}

/** What the composer is told about a region, derived from the plan rather than declared twice. See `spec/kernel/composition.md`. */
export function regionSpecOf(
  spec: SlotSpec,
  decl: RegionDecl,
  degraded?: { fallback?: Uint8Array; placeholder?: Uint8Array },
): RegionSpec {
  return {
    region: spec.name,
    onExceed: decl.fallback ? 'fallback' : 'placeholder',
    ...(spec.budget?.cpuMs !== undefined ? { cpuBudgetMs: spec.budget.cpuMs } : {}),
    ...(decl.contract ? { contract: decl.contract } : {}),
    ...(degraded?.fallback ? { fallback: degraded.fallback } : {}),
    ...(degraded?.placeholder ? { placeholder: degraded.placeholder } : {}),
  }
}

/**
 * The shell signals a region asked for, at the values this render has. Stringified so a value
 * crossing a binding cannot differ from one in a monolith. Intersected with the exposed set: the
 * build already refuses an illegal declaration, so this stops the runtime from widening one.
 */
function exposedTo(
  decl: RegionDecl,
  exposes: readonly string[],
  values: Values,
): Record<string, string> | undefined {
  if (!decl.consumes?.length) return undefined
  const out: Record<string, string> = {}
  const record = values as unknown as Record<string, unknown>
  for (const name of decl.consumes) {
    if (!exposes.includes(name)) continue
    out[name] = String(record[name] ?? '')
  }
  return Object.keys(out).length ? out : undefined
}

function regionSlotOf(
  spec: SlotSpec,
  decl: RegionDecl,
  route: string,
  params: Record<string, string>,
  regions: RegionBindings,
  binding: SlotBinding | undefined,
  renderer?: RenderPort,
  exposed?: Record<string, string>,
): KernelSlot {
  const remote = decl.locus === 'remote'
  const policy = policyOf(spec.cache)
  const regionSpec = regionSpecOf(spec, decl, regions.degraded?.[spec.name])

  // Hoisted, because an incremental region's memo has to outlive one render to be a memo.
  const paint = binding ? paintOf(spec, binding, renderer) : undefined

  return {
    name: spec.name,
    id: remote ? `region:${spec.name}` : (binding as SlotBinding).fragment.entry.id,
    version: remote
      ? (decl.contract?.version ?? 'unversioned')
      : (binding as SlotBinding).fragment.entry.version,
    effects: remote ? regionEffects(decl.contract) : (binding as SlotBinding).fragment.entry.effects,
    needs: [...spec.needs],
    prio: spec.prio,
    executor: 'inline',
    ...(policy ? { policy } : {}),
    render: async (ctx) => {
      const composer = createComposer({
        ports: regions.ports,
        // A local region goes through the composer too. See `spec/kernel/composition.md`.
        ...(binding && paint
          ? {
              local: {
                [spec.name]: async () =>
                  regionStream({ region: spec.name, hops: 0 }, [
                    {
                      kind: 'HTML',
                      header: { s: spec.name },
                      body: await paint(await binding.values(ctx, params)),
                    },
                  ]),
              },
            }
          : {}),
      })
      // A region is given its reads rather than taking them. See `spec/kernel/composition.md`.
      const reads = await readsFor(ctx, decl.contract)
      const outcome = await composer.compose(regionSpec, {
        route,
        params,
        ...(reads ? { reads } : {}),
        ...(exposed ? { exposed } : {}),
        ...regions.request?.(params),
      })
      return outcome.bytes
    },
  }
}

/** Which executors need a name rather than a function: everything but `inline` and `client` is another crash domain. */
function needsAddress(executor: string): boolean {
  return executor !== 'inline' && executor !== 'client'
}

/** A validated plan plus its bindings into a resolver the kernel can call per request. See `spec/kernel/routing.md`. */
export function lowerPlan(plan: Plan, context: ValidateContext, bindings: RouteBindings): RouteResolver {
  assertPlan(plan, context)

  for (const spec of plan.slots) {
    const binding = bindings.slots[spec.name]
    if (spec.region) {
      if (!bindings.regions) {
        throw new PlanError(
          'E_NO_REGION_BINDINGS',
          `${plan.route}: region '${spec.name}' has nothing to compose against. Pass \`regions: { ports }\``,
        )
      }
      if (spec.region.locus === 'remote' && binding) {
        throw new PlanError(
          'E_REGION_BOUND_LOCALLY',
          `${plan.route}: region '${spec.name}' is remote and has a local binding, so two things claim to render it`,
        )
      }
      if (spec.region.locus === 'local' && !binding) {
        throw new PlanError(
          'E_SLOT_UNBOUND',
          `${plan.route}: region '${spec.name}' is local and has no binding, so this process has nothing to render it with`,
        )
      }
      if (spec.region.fallback && !bindings.regions.degraded?.[spec.name]?.fallback) {
        throw new PlanError(
          'E_REGION_FALLBACK_UNBOUND',
          `${plan.route}: region '${spec.name}' declares fallback '${spec.region.fallback}' and \`regions.degraded\` supplies no bytes for it`,
        )
      }
      continue
    }
    if (!binding) {
      throw new PlanError(
        'E_SLOT_UNBOUND',
        `${plan.route}: slot '${spec.name}' has no binding, so there is nothing to render it with`,
      )
    }
    if (needsAddress(spec.executor) && !binding.address) {
      throw new PlanError(
        'E_SLOT_NOT_ADDRESSABLE',
        `${plan.route}: slot '${spec.name}' runs on '${spec.executor}', which cannot receive a closure. Give its binding an address: { module, export }`,
      )
    }
  }
  for (const guard of plan.guards) {
    if (!bindings.guards?.[guard.name]) {
      throw new PlanError(
        'E_UNKNOWN_GUARD',
        `${plan.route}: guard '${guard.name}' has no handler. A guard the runtime cannot evaluate would silently pass`,
      )
    }
  }

  const order = bindings.order ?? orderOf(plan)
  const documentPolicy = policyOf(plan.cache)
  const csp = cspOf(plan)

  const chain = plan.shellChain ?? []
  const nested = bindings.nested ?? []
  if (chain.length !== nested.length) {
    throw new PlanError(
      'E_SHELL_CHAIN_MISMATCH',
      `${plan.route}: the plan nests ${chain.length} layout(s) and the bindings supply ${nested.length}. ` +
        `The plan says what the chain is and the bindings say what renders it; neither can be inferred from the other`,
    )
  }
  for (let i = 0; i < chain.length; i++) {
    const declared = chain[i] as { at: string; fragment: string }
    const bound = nested[i] as FragmentSource & { at: string }
    if (declared.at !== bound.at || declared.fragment !== bound.entry.id) {
      throw new PlanError(
        'E_SHELL_CHAIN_MISMATCH',
        `${plan.route}: link ${i} is declared as '${declared.fragment}' at '${declared.at}' and bound as ` +
          `'${bound.entry.id}' at '${bound.at}'`,
      )
    }
  }
  /** The document's identity and reads, over the whole chain. See `spec/kernel/routing.md`. */
  const document = {
    id: [bindings.shell.entry.id, ...nested.map((link) => link.entry.id)].join('>'),
    version: [bindings.shell.entry.version, ...nested.map((link) => link.entry.version)].join('+'),
    effects: unionEffects([bindings.shell.entry.effects, ...nested.map((link) => link.entry.effects)]),
  }
  const links = nested.map((link) => ({ at: link.at, template: link.entry }))
  const splitter = links.length ? chainSplitter(links) : undefined
  /** One lookup table over the whole chain, composed here rather than per-link on the document request path, which has a byte budget. */
  const resolveChain: Resolver | undefined = links.length
    ? (version: string) => {
        for (const source of [bindings.shell, ...nested]) {
          const found = source.resolve?.(version)
          if (found) return found
        }
        return undefined
      }
    : bindings.shell.resolve

  return async (params) => {
    // Hoisted: a region below may consume one of these via the exposed set.
    const shellValues = (await bindings.shellValues?.(params)) ?? {}
    const route: KernelRoute = {
      path: plan.route,
      template: bindings.shell.entry,
      values: shellValues,
      ...(splitter ? { split: splitter } : {}),
      shell: document,
      order,
      maxConcurrency: plan.maxConcurrency,
      slots: plan.slots.map((spec) =>
        spec.region
          ? regionSlotOf(
              spec,
              spec.region,
              plan.route,
              params,
              bindings.regions as RegionBindings,
              bindings.slots[spec.name],
              bindings.render,
              exposedTo(spec.region, plan.exposes, shellValues),
            )
          : slotOf(spec, bindings.slots[spec.name] as SlotBinding, params, bindings.render),
      ),
      ...(resolveChain ? { resolve: resolveChain } : {}),
      ...(bindings.critical ? { critical: bindings.critical } : {}),
      ...(documentPolicy ? { policy: documentPolicy } : {}),
      ...(plan.guards.length || bindings.envelope || Object.keys(csp).length
        ? { envelope: (ctx: EnvelopeContext) => runPhaseA(plan, bindings, csp, ctx) }
        : {}),
    }
    return route
  }
}

async function runPhaseA(
  plan: Plan,
  bindings: RouteBindings,
  csp: Record<string, string[]>,
  ctx: EnvelopeContext,
): Promise<void> {
  const directives = Object.entries(csp)
  if (directives.length) {
    ctx.setHeader(
      'content-security-policy',
      directives.map(([name, values]) => `${name} ${values.join(' ')}`).join('; '),
    )
  }
  for (const guard of plan.guards) {
    const handler = bindings.guards?.[guard.name] as GuardHandler
    if (await handler(ctx)) continue
    // The first guard to refuse decides. See `spec/kernel/routing.md`.
    if (guard.redirect) ctx.redirect(guard.redirect, guard.status ?? 302)
    else ctx.refuse(guard.status ?? 403)
    return
  }
  await bindings.envelope?.(ctx)
}

/** One entry per route in a table the kernel can match against. */
export interface LoweredRoute {
  pattern: string
  value: RouteResolver
}

/** The same, as a row for the router: the pattern and the resolver together. */
export function routeEntry(plan: Plan, context: ValidateContext, bindings: RouteBindings): LoweredRoute {
  return { pattern: plan.route, value: lowerPlan(plan, context, bindings) }
}
