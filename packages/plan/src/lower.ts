import {
  createSegmentMemo,
  render as renderTemplate,
  renderIncremental,
  type SegmentMemo,
  type TemplateIR,
  type Values,
} from '@weft/ir'
import {
  type CachePolicy,
  type EnvelopeContext,
  type JobAddress,
  type KernelRoute,
  type KernelSlot,
  type Order,
  type PreloadLink,
  type RenderContext,
  type RouteResolver,
} from '@weft/kernel'
import { PlanError, type CacheSpec, type Plan, type SlotSpec } from './dsl.ts'
import { assertPlan, type ValidateContext } from './validate.ts'

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

export interface RouteBindings {
  shell: FragmentSource
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

function slotOf(spec: SlotSpec, binding: SlotBinding, params: Record<string, string>): KernelSlot {
  const { fragment } = binding
  const policy = policyOf(spec.cache)
  const memo = spec.incremental ? createSegmentMemo() : null
  const paint = memo
    ? incrementalRender(fragment, memo)
    : (values: Values) => renderTemplate(fragment.entry, values, fragment.resolve)
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
 * Which executors need a name rather than a function. `inline` runs on the request thread and
 * `client` does not run on the server at all; everything else is another crash domain, and a
 * closure does not cross one.
 */
function needsAddress(executor: string): boolean {
  return executor !== 'inline' && executor !== 'client'
}

export function lowerPlan(plan: Plan, context: ValidateContext, bindings: RouteBindings): RouteResolver {
  assertPlan(plan, context)

  for (const spec of plan.slots) {
    const binding = bindings.slots[spec.name]
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

  return async (params) => {
    const route: KernelRoute = {
      path: plan.route,
      template: bindings.shell.entry,
      values: (await bindings.shellValues?.(params)) ?? {},
      shell: {
        id: bindings.shell.entry.id,
        version: bindings.shell.entry.version,
        effects: bindings.shell.entry.effects,
      },
      order,
      maxConcurrency: plan.maxConcurrency,
      slots: plan.slots.map((spec) => slotOf(spec, bindings.slots[spec.name] as SlotBinding, params)),
      ...(bindings.shell.resolve ? { resolve: bindings.shell.resolve } : {}),
      ...(bindings.critical ? { critical: bindings.critical } : {}),
      ...(documentPolicy ? { policy: documentPolicy } : {}),
      ...(plan.guards.length || bindings.envelope
        ? { envelope: (ctx: EnvelopeContext) => runPhaseA(plan, bindings, ctx) }
        : {}),
    }
    return route
  }
}

async function runPhaseA(plan: Plan, bindings: RouteBindings, ctx: EnvelopeContext): Promise<void> {
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

export function routeEntry(plan: Plan, context: ValidateContext, bindings: RouteBindings): LoweredRoute {
  return { pattern: plan.route, value: lowerPlan(plan, context, bindings) }
}
