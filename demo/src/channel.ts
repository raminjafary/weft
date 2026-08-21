import { render, type Values } from '../../packages/ir/src/index.ts'
import {
  createHub,
  createIntentDispatch,
  createIntentRouter,
  createReads,
  createEnvelope,
  defineIntent,
  envelopeContext,
  lifecycle,
  requestFacts,
  serveIntent,
  type ChannelHub,
  type Intent,
  type SlotRender,
} from '../../packages/kernel/src/index.ts'
import { cookieSession, memoryStore, staticFlags } from '../../packages/adapters/src/index.ts'
import { compileDemo, listBinding } from './compile.ts'
import { CATALOGUE_SKUS, cartOf, cartValues, catalogue, feedItems } from './data.ts'

/**
 * The channel and the intents, which are the two things a demo cannot fake.
 *
 * A `SlotSource` answers "what does this slot look like now", and the hub does the rest: recover
 * the base the client named, diff, memoize the delta under the transition, and stage it into an
 * epoch if the client asked for one. Two browser tabs on the feed are two connections holding the
 * same base, so the second one's delta comes out of the store.
 */
export interface DemoChannel {
  hub: ChannelHub
  intents(request: Request): Promise<Response>
  /** Advance the feed. Every open connection watching it gets a delta from one computation. */
  tick(): Promise<{ tick: number; notified: number }>
  readonly state: { tick: number; rows: number }
}

const store = memoryStore()

export async function channel(shared = store): Promise<DemoChannel> {
  const compiled = await compileDemo()
  const feed = compiled.feed
  const rowsBinding = listBinding(feed)
  const state = { tick: 0, rows: 120 }

  const feedValues = (): Values =>
    ({
      heading: 'Markets',
      count: state.rows,
      generated: Date.now(),
      [rowsBinding]: feedItems(state.rows, state.tick),
    }) as unknown as Values

  /**
   * One source for every slot a channel can refresh. `key` is what makes push invalidation
   * possible: the hub records that this connection is watching that key, so an intent invalidating
   * it produces a STALE frame for exactly the connections holding it.
   */
  const source = ({ slot }: { slot: string }): SlotRender | null => {
    if (slot === 'feed') {
      return {
        ir: feed.entry,
        values: feedValues(),
        resolve: feed.resolve,
        key: 'feed:latest',
        prefer: 'delta',
      }
    }
    if (slot === 'cart') {
      return {
        ir: compiled.cart.entry,
        values: cartValues('demo-shared'),
        resolve: compiled.cart.resolve,
        key: 'cart:demo-shared',
        prefer: 'delta',
      }
    }
    return null
  }

  // ── intents ────────────────────────────────────────────────────────────────────────

  const addLine = defineIntent<{ sku: string; qty: number; fail?: boolean }>({
    name: 'cart.add',
    writes: ['cart'],
    input: (raw) => {
      const body = raw as { sku?: unknown; qty?: unknown; fail?: unknown }
      const sku = String(body.sku ?? '')
      if (!CATALOGUE_SKUS.includes(sku)) {
        throw new Error(`sku must be one of ${CATALOGUE_SKUS.join(', ')}`)
      }
      const qty = Number(body.qty ?? 1)
      if (!Number.isFinite(qty) || qty < 0) throw new Error('qty must be a non-negative number')
      return { sku, qty, ...(body.fail ? { fail: true } : {}) }
    },
    async run(ctx, input) {
      // Deliberate failure, so the optimistic-rollback path is something you can press rather
      // than something you read about.
      if (input.fail) throw new Error('the pricing service refused this line')
      const session = ctx.cookie('sid') ?? 'demo-shared'
      const cart = cartOf(session)
      cart.set(input.sku, (cart.get(input.sku) ?? 0) + input.qty)
      cartOf('demo-shared').set(input.sku, (cartOf('demo-shared').get(input.sku) ?? 0) + input.qty)
      await ctx.revalidate('cart')
      return { refresh: ['cart'], data: { sku: input.sku, name: catalogue(input.sku)?.name } }
    },
  })

  const setQty = defineIntent<{ sku: string; qty: number }>({
    name: 'cart.setQty',
    writes: ['cart'],
    input: (raw) => {
      const body = raw as { sku?: unknown; qty?: unknown }
      const sku = String(body.sku ?? '')
      if (!CATALOGUE_SKUS.includes(sku)) throw new Error('unknown sku')
      return { sku, qty: Math.max(0, Number(body.qty ?? 0)) }
    },
    async run(ctx, input) {
      const session = ctx.cookie('sid') ?? 'demo-shared'
      cartOf(session).set(input.sku, input.qty)
      cartOf('demo-shared').set(input.sku, input.qty)
      await ctx.revalidate('cart')
      return { refresh: ['cart'] }
    },
  })

  // Named directly rather than through `intentId`, because a demo where you cannot see which
  // intent a button fires is a demo that has hidden the interesting part. A real deployment uses
  // the opaque id the compiler derived, and `manifestRegistry` in @weft/adapters is that.
  const table: Record<string, Intent<never>> = {
    'cart.add': addLine as unknown as Intent<never>,
    'cart.setQty': setQty as unknown as Intent<never>,
  }
  const registry = {
    name: 'demo',
    intent: (id: string) => table[id],
    intents: () => Object.keys(table),
  }

  const dispatch = createIntentDispatch({ registry, store: shared })

  const hub = createHub({
    store: shared,
    source,
    templates: (version) =>
      [feed.entry, compiled.cart.entry, ...feed.templates, ...compiled.cart.templates].find(
        (t) => t.version === version,
      ),
    intents: dispatch,
    // A channel has no request, so the caller supplies the context an intent runs against.
    intentContext: () => {
      const life = lifecycle()
      const envelope = createEnvelope(life)
      life.to('envelope')
      const facts = requestFacts(new Request('https://demo.local/channel'))
      return envelopeContext(
        createReads(facts, {
          store: shared,
          session: cookieSession({ cookie: 'sid' }),
          flags: staticFlags({ axes: {} }),
          executors: {},
        }),
        envelope,
      )
    },
  })

  /**
   * The same dispatch over plain HTTP, which is what makes the no-JavaScript path real. A form
   * post lands here, the intent runs, and the answer is a 303 back to where the form was.
   */
  const http = serveIntent({
    registry,
    store: shared,
    routes: createIntentRouter([
      { method: 'POST', pattern: '/app/cart', intent: 'cart.add' },
      { method: 'POST', pattern: '/app/cart/qty', intent: 'cart.setQty' },
      { method: 'POST', pattern: '/i/cart.add', intent: 'cart.add' },
      { method: 'POST', pattern: '/i/cart.setQty', intent: 'cart.setQty' },
    ]),
    ports: {
      store: shared,
      session: cookieSession({ cookie: 'sid' }),
      flags: staticFlags({ axes: {} }),
      executors: {},
    },
    returnTo: (request) => request.headers.get('referer') ?? '/app/cart',
  })

  return {
    hub,
    state,
    intents: (request) => http.handle(request),
    async tick() {
      state.tick++
      // Nothing per-connection here: the store is invalidated once and every connection holding
      // the key is told. Each of them then asks for a delta, and the first one to ask pays for it.
      const result = await hub.invalidate(['feed'], `tick ${state.tick}`)
      return { tick: state.tick, notified: result.notified }
    },
  }
}

export function renderFeed(
  values: Values,
  entry: Parameters<typeof render>[0],
  resolve: Parameters<typeof render>[2],
): string {
  return new TextDecoder().decode(render(entry, values, resolve))
}
