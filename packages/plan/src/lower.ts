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

/**
 * The seam: a plan and some compiled fragments become a route.
 *
 * Everything the kernel needs is either in the plan (placement) or in the compiled fragment
 * (identity, version, effects, the forms it can serve). Nothing is stated twice, and nothing
 * here can state a cache key.
 *
 * The plan is validated before it is lowered, so an invalid plan cannot become a route at all.
 * That ordering matters: a build error is only a build error if nothing downstream can proceed
 * past it.
 */
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
  /**
   * Where this slot's render can be reached by name, for an executor that runs it somewhere a
   * closure cannot go — a worker thread, an isolate, a service binding, another pod.
   *
   * A slot that names such an executor and has no address is a build error rather than a
   * request-time refusal, because the alternative is a CPU budget that looks enforced right up
   * until the first slot that needed it.
   */
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
  /**
   * Layouts nested inside `shell`, outermost first, in the same order as `plan.shellChain`.
   *
   * Two lists rather than one because they answer different questions and are checked against each
   * other: the plan names the fragments so validation can refuse a link with nowhere to go, and
   * these are the bytes-producers the kernel splices in. A chain whose two halves disagree is
   * refused at lowering rather than streamed.
   */
  nested?: readonly (FragmentSource & { at: string })[]
  /**
   * The shell's non-slot values. A function of the matched params only: the shell is rendered
   * as the plan is resolved, before phase B exists, so it cannot read through a context. A
   * shell that needs a request read either does it in `envelope` or that region is a slot.
   */
  shellValues?(params: Record<string, string>): Values | Promise<Values>
  slots: Record<string, SlotBinding>
  guards?: Record<string, GuardHandler>
  /** Phase A work beyond the guards. */
  envelope?(ctx: EnvelopeContext): void | Promise<void>
  critical?: PreloadLink[]
  /** Overrides the order derived from the plan's slot deliveries. */
  order?: Order
  /**
   * Who turns this route's fragments into bytes. Without one the IR renderer is called directly,
   * which is what every route did before the port existed and is still what most of them want.
   *
   * A slot declared `.incremental()` renders through its own memo either way. The port answers
   * *who produces bytes from a template*; incremental answers *which of last time's bytes can be
   * reused*, and a renderer that has never seen the previous values cannot answer the second.
   */
  render?: RenderPort
  /**
   * What this route's regions are composed against. Required only by a plan that declares one.
   *
   * The ports are the deployment's, and they are named here rather than taken from the kernel
   * because composition happens *inside* a slot's render: from the kernel's point of view a region
   * is a local async function, and the boundary is the executor the registry named one level in.
   * That nesting is the design's claim that a tier boundary is a port implementation and not a
   * second render path, so it is worth being able to see it in the types.
   */
  regions?: RegionBindings
}

/** What a region needs beyond a slot: the ports, the request, and the bytes behind its degradation. */
export interface RegionBindings {
  ports: Ports
  /**
   * What a region is told about this request beyond the route and its params — the templates the
   * client holds, an epoch it is being staged into. A function of the params, because a region
   * request has to survive a serialisation and a closure does not.
   */
  request?(params: Record<string, string>): RegionRequest
  /**
   * The bytes behind a region's declared degradation, by region name.
   *
   * One home for both loci, and it is not the slot binding: a remote region has no local binding by
   * construction, and putting a fallback there would mean the one thing a shell most wants to
   * declare about a remote region had nowhere to live. The plan names the fragment, so a typo is a
   * build error; the bytes are the deployment's, the same way a placeholder's always were.
   */
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

/**
 * `out-of-order` the moment any slot asks to stream, `in-order` when none does. A plan whose
 * slots all buffer has expressed no interest in arrival order, and in-order costs no fill
 * mechanism — so the cheaper choice is the derived one rather than the default one.
 */
function orderOf(plan: Plan): Order {
  return plan.slots.some((s) => s.delivery === 'stream') ? 'out-of-order' : 'in-order'
}

/**
 * `.incremental()`, which had been recorded and read by nothing.
 *
 * One memo per slot per lowered route, and content-addressed inside it, so it is shared across
 * every request this isolate serves for that slot. A row that appears in two users' lists is
 * rendered once — the same argument the delta memo makes, one level down.
 *
 * The `previous` value set is deliberately not carried across requests. Two consecutive
 * requests are usually two different users, so a "previous" from the wrong one would make every
 * derived value look dirty and cost a comparison for nothing. Level two pays inside a refresh
 * loop, which is where the caller supplies it; level three pays here, and does not need it.
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

/**
 * How a slot's values become bytes: its own memo when it is incremental, the render port when the
 * deployment bound one, and the IR renderer otherwise. One function, because a region renders the
 * same way a slot does — the difference between them is where, not how.
 */
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

/**
 * A region, lowered.
 *
 * Three things are decided here and each of them is the honest answer to a question the composite
 * cannot answer for itself.
 *
 * **What the kernel is told the slot reads.** For a local region, what the compiler inferred. For a
 * remote one, what the contract carries — and `regionEffects` turns an absent contract into
 * `opaque`, which is uncacheable and private, because a document that advertised itself as
 * shareable on the strength of a region nobody had described is the leak the whole design exists to
 * prevent.
 *
 * **Which executor the kernel sees.** `inline`, always, and that is not a lie: the slot's render
 * *is* a local async function. The boundary is one level in, where the composer dispatches through
 * the executor the registry named, and that is where the budget and the degradation belong — so
 * neither is passed to the kernel, or a breach would be reported twice with two different meanings.
 *
 * **What a failure produces.** The composer's, from the declaration: `optional()` is a placeholder
 * with nothing behind it, `fallback(...)` is bytes the binding supplied.
 */
/**
 * What the composer is told about a region, derived from the plan rather than declared twice.
 *
 * Exported because a region is composed on more than one path — a document request, a refresh over
 * the channel, a route being staged — and the second caller that built this by hand would be the
 * first one to disagree with the plan about a budget or a fallback. There is one derivation and
 * three callers, which is the arrangement in which they cannot drift.
 */
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
 * The shell signals a region asked for, at the values this render has.
 *
 * Stringified, and that is not laziness. These cross a serialisation on their way to another
 * deployment, so a region that received the number `3` in a monolith and the string `"3"` over a
 * binding would have a bug that appears in one topology and not the other — which is the whole class
 * of thing the byte-identical assertion between the two exists to catch. The read vocabulary makes
 * the same choice for the same reason.
 *
 * Intersected with what the shell exposes rather than trusted: validation already refuses a region
 * consuming something outside the exposed set, so this cannot narrow a legal declaration — what it
 * does is make the runtime unable to widen one, which is the half a build check cannot enforce.
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
        // A local region goes through the composer too, and through the registry with it. That is
        // what makes moving it a registry write rather than a redeploy: nothing here knows or cares
        // which of the two it is, and the same check runs over the frames either way.
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
      // Resolved through this context, so reading a cookie on the region's behalf taints the
      // composite exactly as a local fragment reading it would. A region is given its reads rather
      // than taking them, and that is what makes a composed page cacheable at all.
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

/**
 * Which executors need a name rather than a function. `inline` runs on the request thread and
 * `client` does not run on the server at all; everything else is another crash domain, and a
 * closure does not cross one.
 */
function needsAddress(executor: string): boolean {
  return executor !== 'inline' && executor !== 'client'
}

/**
 * A validated plan plus its bindings into a resolver the kernel can call per request.
 *
 * Everything decidable once is decided here — the delivery order, the document policy, the CSP, the
 * chain's identity — so the request path resolves values rather than re-deriving facts.
 */
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
      // A remote region has no local render by definition, and a local one is a slot like any
      // other. Both are legitimate; a *remote* region with a binding is not, because two answers
      // to "what renders this" is how a page ends up showing the wrong one.
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
  // Merged once, at lowering, because it is a property of the plan rather than of the request —
  // and written in phase A, where a header can still be written. A policy per region is not
  // possible: there is one document and one header, which is why a conflict is a build error.
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
  /**
   * The document's identity and reads, over the whole chain.
   *
   * A nested layout is part of the document, so what it reads is what the document reads — and the
   * cache key, the `Vary` and the class all come from this set. Computed once at lowering because
   * the chain is build-time knowledge; recomputing it per request would be the same union every time.
   */
  const document = {
    id: [bindings.shell.entry.id, ...nested.map((link) => link.entry.id)].join('>'),
    version: [bindings.shell.entry.version, ...nested.map((link) => link.entry.version)].join('+'),
    effects: unionEffects([bindings.shell.entry.effects, ...nested.map((link) => link.entry.effects)]),
  }
  const links = nested.map((link) => ({ at: link.at, template: link.entry }))
  const splitter = links.length ? chainSplitter(links) : undefined
  /**
   * One lookup table over the whole chain, composed here because here is where it is free.
   *
   * Every layer brings its own nested templates — list rows, component instances — and the split
   * that streams the chain takes one resolver. Template versions are content addresses, so asking
   * the layers in order cannot answer differently from asking each layer about its own; what it
   * does avoid is a per-link resolver on the document request path, which has a byte budget.
   */
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
    // Hoisted, because the regions below may need it: a shell signal a region consumes is one of
    // these values, and the exposed set is the only channel between the two.
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
    // The first guard to refuse decides. Running the rest would let a later one overwrite a
    // redirect that has already been settled on.
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
