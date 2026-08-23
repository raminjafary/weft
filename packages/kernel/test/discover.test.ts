import assert from 'node:assert/strict'
import { test } from 'node:test'
import { memoryStore } from '@weft/adapters'
import { TEMPLATE_IR_VERSION } from '@weft/ir'
import { WARP_VERSION, frame, residentFrame, str, num, type Frame } from '@weft/warp'
import { createHub, type ChannelSink } from '../src/channel.ts'
import { createExtender, planFrame, type DiscoveredRoute } from '../src/discover.ts'

/**
 * Lazy plan extension: the part of the plan a client does not have, asked for and answered.
 *
 * The protocol rather than the browser, which is the same split `stage.test.ts` makes: what is
 * asserted is which frames come back, what they carry, and what the server refuses. What a client
 * *does* with the answer — one fewer round trip for a link into a different document — is the
 * client's own test and the demo's readout.
 */
function sink(): ChannelSink & { frames: Frame[] } {
  const frames: Frame[] = []
  return {
    frames,
    binding: 'socket',
    open: true,
    send(batch) {
      frames.push(...batch)
    },
    close() {},
  }
}

const CATALOGUE: DiscoveredRoute[] = [
  { pattern: '/', shell: 'sh-main', shared: true, slots: ['body'], css: '/a.css' },
  { pattern: '/checkout/cart', shell: 'sh-main', shared: true, slots: ['body'], next: ['/checkout/pay'] },
  { pattern: '/checkout/pay', shell: 'sh-narrow', shared: false, slots: ['body'] },
]

function hub(routes: DiscoveredRoute[], options: { max?: number } = {}) {
  const held = sink()
  const extender = createExtender({
    ...(options.max ? { max: options.max } : {}),
    resolve: ({ prefix }) => {
      if (prefix === undefined) return { prefix: '/', routes: routes.slice(0, 2) }
      const under = prefix.replace(/\/?\*$/, '')
      const found = routes.filter((route) => route.pattern.startsWith(under))
      return found.length ? { prefix, routes: found } : null
    },
  })
  const built = createHub({
    store: memoryStore(),
    source: () => null,
    warm: { plan: extender.warm },
    onOpen: extender.open,
  })
  return { hub: built, held, extender }
}

function open(built: ReturnType<typeof hub>): Promise<Frame[]> {
  built.hub.open(built.held, 'c1')
  return built.hub.receive('c1', [
    residentFrame({ warp: WARP_VERSION, ir: TEMPLATE_IR_VERSION, forms: ['html', 'delta'] }),
  ])
}

function routesOf(f: Frame): DiscoveredRoute[] {
  return JSON.parse(new TextDecoder().decode(f.body)) as DiscoveredRoute[]
}

test('a connection is told about the plan when it opens, without asking', async () => {
  const built = hub(CATALOGUE)
  const out = await open(built)

  assert.deepEqual(
    out.map((f) => f.kind),
    ['WARP', 'PLAN'],
    'the negotiation, then the one thing a client cannot ask for because it does not know it is missing',
  )
  const plan = out[1] as Frame
  assert.deepEqual(
    routesOf(plan).map((route) => route.pattern),
    ['/', '/checkout/cart'],
  )
  assert.equal(str(plan, 'p'), '/')
  assert.equal(num(plan, 'n'), 2)
})

test('a subtree is asked about by prefix, and the star is optional', async () => {
  const built = hub(CATALOGUE)
  await open(built)

  for (const asked of ['/checkout/*', '/checkout']) {
    const out = await built.hub.receive('c1', [frame('WARM', { plan: asked })])
    const plan = out.find((f) => f.kind === 'PLAN') as Frame
    assert.ok(plan, `${asked} was not answered with a PLAN`)
    assert.deepEqual(
      routesOf(plan).map((route) => route.pattern),
      ['/checkout/cart', '/checkout/pay'],
    )
  }
})

test('what the answer carries is what a client would otherwise make a request to learn', async () => {
  const built = hub(CATALOGUE)
  await open(built)
  const out = await built.hub.receive('c1', [frame('WARM', { plan: '/checkout/*' })])
  const [cart, pay] = routesOf(out.find((f) => f.kind === 'PLAN') as Frame)

  // The expensive one: a link into a different document cannot be swapped in as regions, and
  // learning that by asking costs a round trip and a render of a page nobody clicked.
  assert.equal(cart?.shared, true)
  assert.equal(pay?.shared, false)
  assert.notEqual(cart?.shell, pay?.shell)
  assert.deepEqual(cart?.next, ['/checkout/pay'])
})

test('a prefix that matches nothing is answered with an empty plan rather than a silence', async () => {
  const built = hub(CATALOGUE)
  await open(built)
  const out = await built.hub.receive('c1', [frame('WARM', { plan: '/admin/*' })])
  const plan = out.find((f) => f.kind === 'PLAN') as Frame
  assert.ok(plan, 'a client that hears nothing cannot tell that from a frame in flight')
  assert.equal(num(plan, 'n'), 0)
  assert.equal(str(plan, 'complete'), 'true')
})

test('a truncated answer says it is truncated', async () => {
  const built = hub(CATALOGUE, { max: 1 })
  await open(built)
  const out = await built.hub.receive('c1', [frame('WARM', { plan: '/checkout/*' })])
  const plan = out.find((f) => f.kind === 'PLAN') as Frame
  assert.equal(num(plan, 'n'), 1)
  assert.equal(
    str(plan, 'complete'),
    'false',
    'a silent cap reads to the client as "that is the whole subtree", which is the one wrong conclusion',
  )
})

test('a WARM at a grain nothing answers is refused by name', async () => {
  const built = createHub({ store: memoryStore(), source: () => null })
  built.open(sink(), 'c2')
  await built.receive('c2', [residentFrame({ warp: WARP_VERSION, ir: TEMPLATE_IR_VERSION, forms: ['html'] })])

  const out = await built.receive('c2', [frame('WARM', { plan: '/checkout/*' })])
  assert.equal(str(out[0] as Frame, 'code'), 'E_NO_WARM_HANDLER')
  // A frame the channel *can* answer on its own is unaffected by there being no handlers at all.
  const templates = await built.receive('c2', [frame('WARM', { tpl: 'v-nope' })])
  assert.equal(str(templates[0] as Frame, 'code'), 'E_NO_TEMPLATE_REGISTRY')
})

test('the frame is text-bodied, so the same answer is readable in the text framing', () => {
  const built = planFrame({ prefix: '/x', routes: CATALOGUE })
  assert.equal(built.kind, 'PLAN')
  assert.equal(built.bodyIsText, true)
  assert.equal(routesOf(built).length, 3)
})
