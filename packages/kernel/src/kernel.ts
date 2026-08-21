import type { EffectSet, Resolver, TemplateIR, Values } from '../../ir/src/index.ts'
import { cacheHeaders, resolveKey, type CachePolicy, type ResolvedKey } from './cache.ts'
import {
  createReads,
  envelopeContext,
  renderContext,
  type EnvelopeContext,
  type RenderContext,
} from './context.ts'
import { applyDeferred, createEnvelope, createMailbox, type DeferredMailbox } from './envelope.ts'
import { degrade, inlineExecutor, type ExceedPolicy, type KernelExecutor } from './executor.ts'
import { sendEarlyHints, type HintResult } from './hints.ts'
import { requestFacts, type PreloadLink, type Ports, type RequestFacts } from './ports.ts'
import { lifecycle, type Lifecycle } from './request.ts'
import { resolvePlugins, runPlugins, type Plugin } from './plugins.ts'
import { streamRoute, type Order } from './stream.ts'
import { dispatch, type DagNode } from './waves.ts'

/**
 * The kernel does four things and nothing else: own the request lifecycle as a state
 * machine, resolve a plan, execute it against ports, and own the stream.
 *
 * Everything people normally call a framework feature — ISR, SWR, edge caching, cookie
 * handling, worker pools — is a port implementation on the other side of this file. What
 * stays here is only what cannot be replaced without losing a guarantee: the two phases of
 * the envelope, the derivation of cache keys from effects, and the fact that a render
 * cannot write anything.
 */
export interface KernelSlot {
  name: string
  /** Module and export. Stable across content changes, which is why it is not the version. */
  id: string
  version: string
  effects: EffectSet
  /** Data dependency on other slots. Existence dependency is not declared and does not block. */
  needs?: string[]
  prio?: number
  executor?: string
  cpuBudgetMs?: number
  onExceed?: ExceedPolicy
  policy?: CachePolicy
  /** Emitted when the slot degrades. Honest, cheap, and visibly incomplete. */
  placeholder?: Uint8Array
  render(ctx: RenderContext): Promise<Uint8Array>
}

export interface KernelRoute {
  path: string
  /** The shell. Its slot holes are the boundaries the kernel fills. */
  template: TemplateIR
  values: Values
  resolve?: Resolver
  order?: Order
  maxConcurrency?: number
  /** Phase A. The envelope is open here and nowhere else. */
  envelope?(ctx: EnvelopeContext): Promise<void> | void
  policy?: CachePolicy
  critical?: PreloadLink[]
  slots: KernelSlot[]
}

export interface KernelOptions {
  ports: Ports
  plugins?: readonly Plugin[]
  mailbox?: DeferredMailbox
  clock?: () => number
  /**
   * Which connection this request belongs to, for deferred envelope effects. Without one,
   * a deferrable effect has nowhere to wait and is dropped — which is stated, not hidden.
   */
  connectionOf?(request: Request): string | null
}

export interface KernelTrace {
  states: readonly string[]
  hints: HintResult
  keys: Record<string, ResolvedKey>
  hits: string[]
  degraded: { slot: string; code: string; message: string }[]
  deferred: number
}

export interface Kernel {
  handle(request: Request, route: KernelRoute, params?: Record<string, string>): Promise<Response>
  /** The trace of the last request. Kept separate from the Response so nothing leaks into bytes. */
  readonly trace: KernelTrace | null
  readonly mailbox: DeferredMailbox
}

export function createKernel(options: KernelOptions): Kernel {
  const mailbox = options.mailbox ?? createMailbox()
  const plugins = resolvePlugins(options.plugins ?? [])
  const defaultExecutor = inlineExecutor(options.ports.telemetry)
  let trace: KernelTrace | null = null

  const executorFor = (name?: string): KernelExecutor => {
    if (!name || name === 'inline') return defaultExecutor
    const bound = options.ports.executors[name]
    if (!bound) throw new Error(`E_UNKNOWN_EXECUTOR: no executor named '${name}' is bound`)
    return bound as KernelExecutor
  }

  return {
    get trace() {
      return trace
    },
    mailbox,

    async handle(request, route, params = {}) {
      const life: Lifecycle = lifecycle()
      const envelope = createEnvelope(life)
      const facts = requestFacts(request, params)
      const connection = options.connectionOf
        ? options.connectionOf(request)
        : request.headers.get('x-weft-connection')

      const hints = await sendEarlyHints(life, options.ports.transport, route.critical ?? [])
      options.ports.telemetry?.mark('hints', performance.now())

      life.to('envelope')

      // A deferred effect from a previous response becomes a real header here, which is the
      // only place it still can be one.
      if (connection) applyDeferred(envelope, mailbox.claim(connection))

      const reads = createReads(facts, options.ports, options.clock ? { clock: options.clock } : {})
      const phaseA = envelopeContext(reads, envelope)

      for (const cookie of (await options.ports.session.rotateIfStale?.(facts)) ?? []) {
        envelope.setCookie(cookie)
      }

      const pluginResult = await runPlugins(plugins, phaseA)
      if (pluginResult.response) {
        life.to('settled')
        trace = { states: life.log, hints, keys: {}, hits: [], degraded: [], deferred: 0 }
        return pluginResult.response
      }

      await route.envelope?.(phaseA)
      options.ports.telemetry?.mark('envelope.end', performance.now())

      // Still phase A: the plan resolves and the derived headers are written while the
      // envelope is open, because `Cache-Control` and `Vary` come from the same effect
      // signature that produced the keys and there is no later moment they could be added.
      const keys = await resolveAll(route, facts, options.ports)
      const headers = routeHeaders(route, keys)
      for (const [name, value] of Object.entries(headers)) envelope.header(name, value)
      // Set last and only if phase A did not, so a route that produces something other than a
      // document can say so while the envelope is still open.
      if (!envelope.redirected) envelope.headerIfUnset('content-type', 'text/html; charset=utf-8')

      life.to('planned')
      const init = envelope.seal()

      if (envelope.redirected) {
        life.to('settled')
        trace = { states: life.log, hints, keys, hits: [], degraded: [], deferred: 0 }
        return new Response(null, init)
      }

      life.to('streaming')

      const hits: string[] = []
      const degraded: { slot: string; code: string; message: string }[] = []
      // One gate per slot. The stream awaits these; the wave scheduler opens them, so
      // document order and completion order stay independent of each other.
      const results = new Map<string, Gate>()
      for (const slot of route.slots) results.set(slot.name, gate())

      const nodes: DagNode[] = route.slots.map((slot) => ({
        name: slot.name,
        needs: slot.needs ?? [],
        prio: slot.prio ?? 0,
      }))

      const renderOne = async (slot: KernelSlot): Promise<Uint8Array> => {
        const resolved = keys[slot.name] as ResolvedKey
        if (resolved.key) {
          const entry = await options.ports.store.get(resolved.key)
          if (entry) {
            hits.push(slot.name)
            return entry.value
          }
        }
        const outcome = await executorFor(slot.executor).run({
          slot: slot.name,
          ...(slot.cpuBudgetMs !== undefined ? { cpuBudgetMs: slot.cpuBudgetMs } : {}),
          run: async () => slot.render(renderContext(reads, envelope)),
        })
        if (outcome.failure) {
          degraded.push({ slot: slot.name, ...outcome.failure })
          options.ports.telemetry?.measure('slot.degraded', outcome.ms, {
            slot: slot.name,
            code: outcome.failure.code,
          })
          return degrade(
            {
              slot: slot.name,
              policy: slot.onExceed ?? 'placeholder',
              ...(slot.placeholder ? { placeholder: slot.placeholder } : {}),
            },
            outcome.failure,
          )
        }
        if (resolved.key && slot.policy) {
          await options.ports.store.set(resolved.key, outcome.bytes, {
            class: resolved.class,
            ...(slot.policy.ttlMs !== undefined ? { ttlMs: slot.policy.ttlMs } : {}),
            ...(slot.policy.tags ? { tags: slot.policy.tags } : {}),
          })
        }
        return outcome.bytes
      }

      const byName = new Map(route.slots.map((s) => [s.name, s]))
      const work = dispatch(nodes, {
        maxConcurrency: route.maxConcurrency ?? options.ports.scheduler?.maxConcurrency ?? 6,
        run: async (node) => {
          const slot = byName.get(node.name) as KernelSlot
          const bytes = await renderOne(slot)
          results.get(node.name)?.open(bytes)
        },
      })

      const stream = streamRoute(
        {
          template: route.template,
          values: route.values,
          ...(route.resolve ? { resolve: route.resolve } : {}),
          slots: Object.fromEntries(
            route.slots.map((slot) => [
              slot.name,
              () => results.get(slot.name)?.bytes ?? Promise.resolve(new Uint8Array(0)),
            ]),
          ),
        },
        { order: route.order ?? 'out-of-order' },
      )

      const owed = envelope.deferred.length
      const settled = work.then(() => {
        life.to('settled')
        if (connection) mailbox.owe(connection, envelope.deferred)
        options.ports.telemetry?.mark('settled', performance.now())
      })
      void settled.catch(() => {})

      trace = { states: life.log, hints, keys, hits, degraded, deferred: owed }
      return new Response(stream, init)
    },
  }
}

interface Gate {
  open(bytes: Uint8Array): void
  bytes: Promise<Uint8Array>
}

function gate(): Gate {
  const held: { open?: (bytes: Uint8Array) => void } = {}
  const bytes = new Promise<Uint8Array>((resolve) => {
    held.open = resolve
  })
  return { open: held.open as (bytes: Uint8Array) => void, bytes }
}

async function resolveAll(
  route: KernelRoute,
  facts: RequestFacts,
  ports: Ports,
): Promise<Record<string, ResolvedKey>> {
  const out: Record<string, ResolvedKey> = {}
  for (const slot of route.slots) {
    out[slot.name] = await resolveKey(
      { id: slot.id, version: slot.version, effects: slot.effects },
      facts,
      ports,
    )
  }
  return out
}

/**
 * The document's own headers. `Vary` is the union of every slot's, because the document
 * contains all of them; `Cache-Control` is the route's declared policy checked against the
 * strictest class among its slots, so one private region cannot be advertised as public.
 */
function routeHeaders(route: KernelRoute, keys: Record<string, ResolvedKey>): Record<string, string> {
  const vary = new Set<string>()
  let strictest: ResolvedKey['class'] = 'static'
  for (const resolved of Object.values(keys)) {
    for (const header of resolved.vary) vary.add(header)
    if (resolved.class === 'private') strictest = 'private'
    else if (resolved.class === 'shared' && strictest !== 'private') strictest = 'shared'
  }
  const document: ResolvedKey = {
    key: null,
    class: strictest,
    components: {},
    axes: {},
    vary: [...vary].sort(),
    ttlRequired: false,
    reason: 'document',
  }
  return cacheHeaders(document, route.policy)
}
