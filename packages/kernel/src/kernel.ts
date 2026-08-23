import type { EffectSet, Resolver, TemplateIR, Values } from '@weft/ir'
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
import {
  requestFacts,
  type Coalescer,
  type JobAddress,
  type PreloadLink,
  type Ports,
  type RequestFacts,
} from './ports.ts'
import type { Router } from './router.ts'
import { lifecycle, type Lifecycle } from './request.ts'
import { runPlugins, type PluginSchedule, type ReadGuard } from './plugins.ts'
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
  /**
   * Where this slot's render lives, for an executor that runs it somewhere a closure cannot
   * reach. Without one only same-thread executors can take the slot.
   */
  address?: JobAddress
  render(ctx: RenderContext): Promise<Uint8Array>
}

export interface KernelRoute {
  path: string
  /** The shell. Its slot holes are the boundaries the kernel fills. */
  template: TemplateIR
  values: Values
  resolve?: Resolver
  /**
   * The shell's own identity and inferred reads. A shell that reads a cookie contributes to
   * the document's `Vary` and to its class exactly as a slot does — it is a fragment, and
   * leaving it out of the union would advertise a document as shareable on the strength of
   * its slots alone.
   */
  shell?: { id: string; version: string; effects: EffectSet }
  order?: Order
  maxConcurrency?: number
  /** Phase A. The envelope is open here and nowhere else. */
  envelope?(ctx: EnvelopeContext): Promise<void> | void
  policy?: CachePolicy
  critical?: PreloadLink[]
  slots: KernelSlot[]
}

/**
 * What a matched route resolves to. The params come from the router, so a plan can be lowered
 * once and produce a route per request without the kernel knowing what a plan is.
 */
/**
 * A plan, resolved for one request.
 *
 * `params` is what the router matched. `url` is the request's, and it is here because "resolved
 * per request" is not a meaningful phrase if the resolver cannot see the request: a page whose
 * subject is a per-slot budget or a delivery order has to be able to read a control, and a control
 * on a server-rendered page is a query parameter.
 *
 * This decides *placement*, which is the plan's own business. It cannot smuggle an unkeyed read
 * into a render: what a cache key contains still comes from the effect set the compiler inferred,
 * and nothing here can add to it.
 */
export type RouteResolver = (params: Record<string, string>, url?: URL) => KernelRoute | Promise<KernelRoute>

export interface KernelOptions {
  ports: Ports
  /**
   * A schedule, not a list. Ordering, the cycle check and the ambiguity check are inferred
   * from static declarations, so they belong to the build: call `resolvePlugins` once and
   * hand the result here. It also keeps the graph out of the request path's bytes.
   */
  plugins?: PluginSchedule
  /**
   * Dev-only enforcement of a plugin's declared reads. Pass `guardReads`; omit it in
   * production, where the check has already had every chance to fire.
   */
  guard?: ReadGuard
  mailbox?: DeferredMailbox
  clock?: () => number
  /**
   * Which connection this request belongs to, for deferred envelope effects. Without one,
   * a deferrable effect has nowhere to wait and is dropped — which is stated, not hidden.
   */
  connectionOf?(request: Request): string | null
  /** The route table. Without one, `serve()` has nothing to match and says so. */
  routes?: Router<RouteResolver>
  /**
   * What happens when two requests miss the same cacheable key at once. Without one they both
   * render, which is the behaviour a cache is supposed to prevent and the behaviour that turns
   * a cold cache into an incident. `leaseCoalescer` is the implementation; it is opt-in because
   * the good version of this is store-specific and the kernel should not have a favourite.
   */
  coalesce?: Coalescer
  /** What an unmatched path returns. A 404 with no body by default. */
  notFound?(request: Request): Response | Promise<Response>
  /**
   * What answers a request that is not a GET or a HEAD. A document is a GET; a mutation is
   * not, and dispatching one is a separate capability with its own entry and its own byte
   * ceiling — see `entry-intent.ts`. Without one, a non-safe method is a 405 with an `Allow`
   * header rather than being routed to a document, because serving a page in answer to a POST
   * is how a write ends up looking like it succeeded.
   */
  intents?(request: Request): Response | Promise<Response>
}

export interface KernelTrace {
  states: readonly string[]
  hints: HintResult
  keys: Record<string, ResolvedKey>
  /** The shell's own key, when the route declared its identity. */
  document: ResolvedKey | null
  hits: string[]
  degraded: { slot: string; code: string; message: string }[]
  /** Slots that missed, waited for another renderer's result, and got it. A stampede avoided. */
  coalesced: string[]
  deferred: number
  /** Which pattern matched and with what params. Null when `handle` was called directly. */
  matched: { pattern: string; params: Record<string, string> } | null
}

export interface Kernel {
  /**
   * Match a request against the route table and serve it. This is the whole entry point: a
   * Request in, a Response out, and nothing else to mount.
   */
  serve(request: Request): Promise<Response>
  handle(request: Request, route: KernelRoute, params?: Record<string, string>): Promise<Response>
  /** The trace of the last request. Kept separate from the Response so nothing leaks into bytes. */
  readonly trace: KernelTrace | null
  readonly mailbox: DeferredMailbox
}

export function createKernel(options: KernelOptions): Kernel {
  const mailbox = options.mailbox ?? createMailbox()
  const plugins = options.plugins ?? { filters: [], waves: [], axes: {} }
  const defaultExecutor = inlineExecutor(options.ports.telemetry)
  let trace: KernelTrace | null = null

  const executorFor = (name?: string): KernelExecutor => {
    if (!name || name === 'inline') return defaultExecutor
    const bound = options.ports.executors[name]
    if (!bound) throw new Error(`E_UNKNOWN_EXECUTOR: no executor named '${name}' is bound`)
    return bound as KernelExecutor
  }

  /**
   * Declared as a function rather than a method so `serve` can call it directly. A kernel
   * whose entry point breaks when somebody destructures it is a kernel with a footgun.
   */
  async function handle(
    request: Request,
    route: KernelRoute,
    params: Record<string, string> = {},
  ): Promise<Response> {
    const life: Lifecycle = lifecycle()
    const envelope = createEnvelope(life)
    const facts = requestFacts(request, params)
    const connection = options.connectionOf
      ? options.connectionOf(request)
      : request.headers.get('x-weft-connection')

    // The route's own links win; failing that the assets port is asked what this route needs
    // before it has been rendered, which is the whole point of 103 — discovery without commitment.
    const critical = route.critical ?? options.ports.assets?.criticalFor(route.path) ?? []
    const hints = await sendEarlyHints(life, options.ports.transport, critical)
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

    const pluginResult = await runPlugins(plugins, phaseA, options.guard)
    if (pluginResult.response) {
      life.to('settled')
      trace = { ...emptyTrace(), states: life.log, hints }
      return pluginResult.response
    }

    await route.envelope?.(phaseA)
    options.ports.telemetry?.mark('envelope.end', performance.now())

    // Still phase A: the plan resolves and the derived headers are written while the
    // envelope is open, because `Cache-Control` and `Vary` come from the same effect
    // signature that produced the keys and there is no later moment they could be added.
    const keys = await resolveAll(route, facts, options.ports)
    const document = route.shell
      ? await resolveKey(
          { id: route.shell.id, version: route.shell.version, effects: route.shell.effects },
          facts,
          options.ports,
        )
      : null
    const headers = routeHeaders(route, keys, document)
    for (const [name, value] of Object.entries(headers)) envelope.header(name, value)
    // Set last and only if phase A did not, so a route that produces something other than a
    // document can say so while the envelope is still open.
    if (!envelope.redirected) envelope.headerIfUnset('content-type', 'text/html; charset=utf-8')

    life.to('planned')
    const init = envelope.seal()

    if (envelope.redirected || envelope.refused) {
      life.to('settled')
      trace = { ...emptyTrace(), states: life.log, hints, keys, document }
      return new Response(null, init)
    }

    life.to('streaming')

    const hits: string[] = []
    const coalesced: string[] = []
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
      const cacheable = Boolean(resolved.key && slot.policy)
      if (resolved.key) {
        const entry = await options.ports.store.get(resolved.key)
        if (entry) {
          hits.push(slot.name)
          return entry.value
        }
      }

      // A miss under load is where a cache stops helping: N concurrent requests all miss and
      // all render, and the render is the expensive part. The kernel knows the two things that
      // decide it — this key is cacheable, and a render is about to happen — and hands both to
      // whatever was wired to do something about it. It does not decide *how*: a lease TTL, a
      // bounded wait, polling against pub/sub are all properties of the store, and a Redis
      // adapter can be told when the fill happened where an isolate-local map can only poll.
      if (!cacheable || !options.coalesce) return render(slot, resolved)
      const result = await options.coalesce(resolved.key as string, () => render(slot, resolved))
      if (result.waited) {
        hits.push(slot.name)
        coalesced.push(slot.name)
      }
      return result.bytes
    }

    const render = async (slot: KernelSlot, resolved: ResolvedKey): Promise<Uint8Array> => {
      const outcome = await executorFor(slot.executor).run({
        slot: slot.name,
        ...(slot.cpuBudgetMs !== undefined ? { cpuBudgetMs: slot.cpuBudgetMs } : {}),
        ...(slot.address ? { address: slot.address } : {}),
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
    const scheduler = options.ports.scheduler
    const work = dispatch(nodes, {
      maxConcurrency: route.maxConcurrency ?? scheduler?.maxConcurrency ?? 6,
      ...(scheduler ? { order: (ready) => scheduler.order(ready) } : {}),
      run: async (node) => {
        const held = results.get(node.name) as Gate
        try {
          held.open(await renderOne(byName.get(node.name) as KernelSlot))
        } catch (error) {
          // The stream is awaiting this slot. Handing it the failure is what ends the response;
          // swallowing it is what used to hang it.
          held.fail(error)
          throw error
        }
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

    trace = {
      states: life.log,
      hints,
      keys,
      document,
      hits,
      coalesced,
      degraded,
      deferred: owed,
      matched: null,
    }
    return new Response(stream, init)
  }

  return {
    get trace() {
      return trace
    },
    mailbox,
    handle,

    async serve(request) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        if (!options.intents) {
          return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } })
        }
        return options.intents(request)
      }
      if (!options.routes) {
        throw new Error('E_NO_ROUTES: serve() needs a route table; pass `routes` to createKernel')
      }
      const url = new URL(request.url)
      const matched = options.routes.match(url)
      if (!matched) {
        trace = emptyTrace()
        return options.notFound ? options.notFound(request) : new Response(null, { status: 404 })
      }
      const route = await matched.value(matched.params, url)
      const response = await handle(request, route, matched.params)
      if (trace) trace.matched = { pattern: matched.pattern, params: matched.params }
      return response
    },
  }
}

function emptyTrace(): KernelTrace {
  return {
    states: [],
    hints: { sent: false, links: [] },
    keys: {},
    document: null,
    hits: [],
    coalesced: [],
    degraded: [],
    deferred: 0,
    matched: null,
  }
}

/**
 * One slot's bytes, awaited by the stream and opened by the render.
 *
 * It has to be able to fail. A slot whose render throws — which is exactly what
 * `onExceed: 'fail'` is for — would otherwise leave this promise pending forever, and the stream
 * awaiting it would never close: the shell and every other slot would be on the wire and the
 * response would simply never end. A request that has already failed and does not say so is the
 * one outcome indistinguishable from a hung server.
 */
interface Gate {
  open(bytes: Uint8Array): void
  fail(error: unknown): void
  bytes: Promise<Uint8Array>
}

function gate(): Gate {
  let open!: Gate['open']
  let fail!: Gate['fail']
  const bytes = new Promise<Uint8Array>((a, b) => {
    open = a
    fail = b
  })
  // The stream is the only awaiter and it may already have gone, so a rejection with nobody
  // listening would take the process down. The rejection still reaches whoever does await.
  void bytes.catch(() => {})
  return { open, fail, bytes }
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
function routeHeaders(
  route: KernelRoute,
  keys: Record<string, ResolvedKey>,
  shell: ResolvedKey | null,
): Record<string, string> {
  const vary = new Set<string>()
  let strictest: ResolvedKey['class'] = 'static'
  for (const resolved of [...Object.values(keys), ...(shell ? [shell] : [])]) {
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
