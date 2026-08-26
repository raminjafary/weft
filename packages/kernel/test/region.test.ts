import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  FRAMES,
  encodeStream,
  frame,
  residentFrame,
  str,
  WARP_VERSION,
  type Frame,
  type FrameKind,
} from '@weft/warp'
import { TEMPLATE_IR_VERSION } from '@weft/ir'
import { collectingTelemetry, cookieSession, memoryStore, staticFlags } from '@weft/adapters'
import {
  announceRegion,
  channelRegions,
  createComposer,
  createHub,
  readRegion,
  readRegionTree,
  regionGraph,
  regionProbeStream,
  regionStream,
  treeHops,
  type ChannelSink,
  type KernelExecutor,
  type Ports,
  type RegionBinding,
} from '../src/index.ts'

const utf8 = new TextEncoder()
const text = new TextDecoder()

function ports(regions: readonly RegionBinding[], telemetry = collectingTelemetry()): Ports {
  return {
    store: memoryStore(),
    telemetry,
    session: cookieSession({ cookie: 'sid' }),
    flags: staticFlags({ axes: {} }),
    executors: {},
    registry: {
      name: 'test',
      intent: () => undefined,
      intents: () => [],
      region: (name) => regions.find((r) => r.region === name),
      regions: () => regions.map((r) => r.region),
    },
  }
}

/** A region's answer, built by hand so a test can say something a well-behaved service would not. */
function answer(announced: string, frames: readonly Frame[], extra: object = {}): Uint8Array {
  return new Uint8Array(
    encodeStream([announceRegion({ region: announced, hops: 0, ...extra }), ...frames] as Frame[]),
  )
}

function markup(region: string, html: string): Frame {
  return frame('HTML', { s: region }, utf8.encode(html), true)
}

/** An executor that is a boundary and answers with bytes somebody handed the test. */
function tier(bytes: Uint8Array): KernelExecutor {
  return {
    name: 'shelf',
    kind: 'svc',
    preemption: 'at-await',
    run: async (job) => ({ slot: job.slot, ms: 1, bytes }),
  }
}

test('a region resolves through the registry and renders in this process, which is the monolith', async () => {
  const telemetry = collectingTelemetry()
  const composer = createComposer({
    ports: ports([{ region: 'search', executor: 'inline' }], telemetry),
    local: {
      search: () => regionStream({ region: 'search', hops: 0 }, [markup('search', '<form>q</form>')]),
    },
  })

  const outcome = await composer.compose({ region: 'search' })

  assert.equal(outcome.failure, undefined)
  assert.equal(text.decode(outcome.bytes), '<form>q</form>')
  assert.equal(outcome.hops, 0, 'a region this process renders crosses no boundary')
  assert.equal(outcome.executor, 'inline')
  assert.equal(composer.hops, 0)
  assert.ok(telemetry.measures.some((m) => m.name === 'region.composed'))
})

test('a region names the deployment serving it, and moving it is a registry write', async () => {
  // The whole reason the registry is a port: the shell below says `search` twice and never says
  // where `search` is. The second answer names a different revision because an entry changed, not
  // because anything was recompiled.
  const bindings: RegionBinding[] = [{ region: 'search', executor: 'inline', revision: 'search-41' }]
  const composer = createComposer({
    ports: ports(bindings),
    local: { search: () => regionStream({ region: 'search', hops: 0 }, [markup('search', '<i>q</i>')]) },
  })

  assert.equal((await composer.compose({ region: 'search' })).revision, 'search-41')
  bindings[0] = { region: 'search', executor: 'inline', revision: 'search-42' }
  assert.equal((await composer.compose({ region: 'search' })).revision, 'search-42')
})

test('a region that announces somebody else is refused, so a registry entry cannot choose its hole', async () => {
  const composer = createComposer({
    // A misconfigured registry: `search` points at the deployment that serves recommendations.
    ports: ports([{ region: 'search', executor: 'inline' }]),
    local: { search: () => answer('recs', [markup('recs', '<ul></ul>')]) },
  })

  const outcome = await composer.compose({
    region: 'search',
    onExceed: 'fallback',
    fallback: utf8.encode('<form>search</form>'),
  })

  assert.equal(outcome.failure?.code, 'E_REGION_ESCAPE')
  assert.match(outcome.failure?.message ?? '', /announced itself as 'recs'/)
  assert.equal(
    text.decode(outcome.bytes),
    '<form>search</form>',
    'the declared degradation, not an error page',
  )
})

test('a region writing into a sibling’s hole is refused rather than forwarded', async () => {
  const composer = createComposer({
    ports: ports([{ region: 'search', executor: 'inline' }]),
    local: { search: () => answer('search', [markup('search', '<i>q</i>'), frame('DELTA', { s: 'cart' })]) },
  })

  const outcome = await composer.compose({ region: 'search' })

  assert.equal(outcome.failure?.code, 'E_REGION_ESCAPE')
  assert.match(outcome.failure?.message ?? '', /named slot 'cart'/)
})

test('a slot inside a region belongs to that region, so a nested name is allowed', () => {
  const read = readRegion(
    'search',
    answer('search', [markup('search', '<i>q</i>'), frame('TPL', { s: 'search:results', tpl: 'abc' })]),
  )

  assert.equal(text.decode(read.html), '<i>q</i>')
  assert.equal(read.frames.length, 1, 'the template goes to the client; the markup goes in the hole')
  assert.equal(read.frames[0]?.kind, 'TPL')
})

test('every downlink frame is either one a region sends or one with a stated reason it may not', () => {
  // A refusal list that quietly missed a kind would be a hole nobody notices, so the gate is over
  // the whole vocabulary rather than over the examples below.
  const sends = new Set<string>([
    'REGION',
    'HTML',
    'TPL',
    'DATA',
    'DELTA',
    'PATCH',
    'SIGNAL',
    'MOD',
    'CSS',
    'SLOT',
    'ERROR',
    // A region naming its own hole is saying the only thing it is in a position to know: that what
    // it served is no longer current. Which connections are showing that hole is the composite's
    // answer, and naming a sibling's is still an escape.
    'STALE',
  ])
  const unclassified: string[] = []
  for (const [kind, def] of Object.entries(FRAMES)) {
    if (def.dir !== 'down' || sends.has(kind)) continue
    try {
      readRegion('search', answer('search', [frame(kind as FrameKind, {})]))
      unclassified.push(`${kind}: forwarded`)
    } catch (error) {
      const message = (error as Error).message
      if (!message.includes('E_REGION_FRAME')) unclassified.push(`${kind}: ${message}`)
    }
  }

  assert.deepEqual(unclassified, [])
})

test('an unscoped SIGNAL is the composite’s, so a region sending one is an escape', () => {
  // The one frame kind a region may send that does not address a slot. Left unchecked it would let a
  // region write a value its siblings read, which is the coupling the exposed set exists instead of.
  assert.throws(
    () => readRegion('search', answer('search', [frame('SIGNAL', { name: 'locale', v: 'ar' })])),
    /E_REGION_ESCAPE.*SIGNAL naming no slot/s,
  )
})

test('a region’s own signal is allowed once it says whose it is', () => {
  const read = readRegion(
    'search',
    answer('search', [frame('SIGNAL', { s: 'search', name: 'query', v: 'sumac' })]),
  )
  assert.equal(read.frames.length, 1)
  assert.equal(read.frames[0]?.kind, 'SIGNAL')
})

test('a region that could send a SHELL could replace the page it is part of', () => {
  assert.throws(
    () => readRegion('search', answer('search', [frame('SHELL', { route: '/evil' })])),
    /E_REGION_FRAME.*SHELL/s,
  )
})

test('an unannounced stream is unattributable, so it is refused before anything is read', () => {
  assert.throws(
    () => readRegion('search', new Uint8Array(encodeStream([markup('search', '<i>q</i>')]))),
    /E_REGION_UNANNOUNCED/,
  )
})

test('a region serving a contract this shell was not built against degrades rather than renders', async () => {
  const composer = createComposer({
    ports: ports([{ region: 'search', executor: 'inline' }]),
    local: {
      search: () =>
        answer('search', [markup('search', '<i>q</i>')], { contract: { id: 'search', version: '3.0.0' } }),
    },
  })

  const outcome = await composer.compose({
    region: 'search',
    contract: { id: 'search', version: '2.1.0' },
    onExceed: 'placeholder',
    placeholder: utf8.encode('<div class=skeleton></div>'),
  })

  assert.equal(outcome.failure?.code, 'E_REGION_CONTRACT')
  assert.match(outcome.failure?.message ?? '', /3\.0\.0.*2\.1\.0/s)
  assert.equal(text.decode(outcome.bytes), '<div class=skeleton></div>')
})

test('a frame kind this build does not know is stepped over, which is what makes a minor additive', () => {
  // A frame from a later minor: a code this build has no name for, with a length prefix that
  // says how far to step.
  const fromTheFuture = new Uint8Array(8)
  fromTheFuture[0] = 0x7f
  const read = readRegion(
    'search',
    new Uint8Array([...answer('search', [markup('search', '<i>q</i>')]), ...fromTheFuture]),
  )

  assert.equal(text.decode(read.html), '<i>q</i>')
  assert.equal(read.frames.length, 0)
})

test('an optional region that failed is a page with nothing in that hole, and nobody is paged', async () => {
  const composer = createComposer({
    ports: ports([{ region: 'recs', executor: 'inline' }]),
    local: {
      recs: () =>
        regionStream({ region: 'recs', hops: 0 }, [
          frame('ERROR', { s: 'recs', code: 'E_UPSTREAM', reason: 'the model service is down' }),
        ]),
    },
  })

  // `optional()` is `placeholder` with no placeholder, which is the vocabulary a slot already has
  // rather than a second one.
  const outcome = await composer.compose({ region: 'recs' })

  assert.equal(outcome.failure?.code, 'E_UPSTREAM')
  assert.equal(outcome.failure?.message, 'the model service is down')
  assert.equal(outcome.bytes.length, 0)
})

test('a region nobody can resolve refuses by name rather than rendering nothing', async () => {
  const bare = createComposer({
    ports: {
      ...ports([]),
      registry: { name: 'intents-only', intent: () => undefined, intents: () => [] },
    },
  })
  await assert.rejects(() => bare.compose({ region: 'search' }), /E_NO_REGION_REGISTRY/)

  const empty = createComposer({ ports: ports([]) })
  await assert.rejects(() => empty.compose({ region: 'search' }), /E_NO_SUCH_REGION/)

  const unbound = createComposer({ ports: ports([{ region: 'search', executor: 'svc:search' }]) })
  await assert.rejects(() => unbound.compose({ region: 'search' }), /E_UNKNOWN_EXECUTOR/)

  const missing = createComposer({ ports: ports([{ region: 'search', executor: 'inline' }]) })
  await assert.rejects(() => missing.compose({ region: 'search' }), /E_NO_LOCAL_REGION/)
})

test('a region composing regions is a tree, and the hops add up', async () => {
  // A shelf that reached one further deployment of its own says so, and the composite reports two
  // boundaries rather than the one it can see. This is the number the design says a build should
  // be able to state rather than a deployment discover under load.
  const base = ports([{ region: 'search', executor: 'shelf', address: { module: './x.ts', export: 'y' } }])
  const composer = createComposer({
    ports: {
      ...base,
      executors: { shelf: tier(answer('search', [markup('search', '<i>q</i>')], { hops: 1 })) },
    },
  })

  const outcome = await composer.compose({ region: 'search' })

  assert.equal(outcome.hops, 2)
  assert.equal(outcome.executor, 'shelf')
})

test('a region that runs somewhere else cannot be handed a closure, and says so rather than running here', async () => {
  const base = ports([{ region: 'search', executor: 'shelf' }])
  // An executor that does what `inline` does — call the job — while claiming to be a boundary.
  const calls: KernelExecutor = {
    name: 'shelf',
    kind: 'svc',
    preemption: 'at-await',
    run: async (job) => {
      try {
        return { slot: job.slot, ms: 0, bytes: await job.run(new AbortController().signal) }
      } catch (error) {
        return {
          slot: job.slot,
          ms: 0,
          bytes: new Uint8Array(0),
          failure: { code: 'E_SLOT_FAILED', message: (error as Error).message },
        }
      }
    },
  }
  const composer = createComposer({
    ports: {
      ...base,
      executors: { shelf: calls },
    },
  })

  const outcome = await composer.compose({ region: 'search' })

  assert.match(outcome.failure?.message ?? '', /E_REGION_NOT_LOCAL/)
})

/**
 * A region over a live channel, which is the same region answering a different question: the page
 * is already there, so what travels is the least that has to — and the region is the only side that
 * can decide what that is, because it is the side with the template.
 */
function channelSink(): ChannelSink & { frames: Frame[] } {
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

async function negotiated(hub: ReturnType<typeof createHub>, id: string): Promise<void> {
  hub.open(channelSink(), id)
  await hub.receive(id, [residentFrame({ warp: WARP_VERSION, ir: TEMPLATE_IR_VERSION })])
}

test('a region is refreshed over a channel, and what a client needs to apply it travels with it', async () => {
  const composer = createComposer({
    ports: ports([{ region: 'results', executor: 'inline' }]),
    local: {
      results: () =>
        regionStream({ region: 'results', hops: 0 }, [
          markup('results', '<ul><li>one</li></ul>'),
          frame('TPL', { s: 'results', tpl: 'results-1' }),
        ]),
    },
  })
  const regions = channelRegions({ composer, regions: { results: { region: 'results' } } })
  const hub = createHub({ store: memoryStore(), source: (request) => regions(request) })
  await negotiated(hub, 'c1')

  const out = await hub.receive('c1', [frame('REFRESH', { s: 'results' })])

  assert.deepEqual(
    out.map((f) => f.kind),
    ['TPL', 'HTML'],
    'the template first, then the markup that needs it',
  )
  assert.equal(text.decode(out[1]?.body as Uint8Array), '<ul><li>one</li></ul>')
})

test('a region staged into an epoch paints nothing, and its template does not wait for the commit', async () => {
  const composer = createComposer({
    ports: ports([{ region: 'results', executor: 'inline' }]),
    local: {
      results: () =>
        regionStream({ region: 'results', hops: 0 }, [
          markup('results', '<ul><li>two</li></ul>'),
          frame('CSS', { href: '/a/results.css' }),
        ]),
    },
  })
  const regions = channelRegions({ composer, regions: { results: { region: 'results' } } })
  const hub = createHub({ store: memoryStore(), source: (request) => regions(request) })
  await negotiated(hub, 'c2')

  const staged = await hub.receive('c2', [frame('REFRESH', { s: 'results', epoch: 'e-1' })])
  assert.deepEqual(
    staged.map((f) => f.kind),
    ['CSS'],
    'a stylesheet paints nothing, so holding it back would only delay the frame that needs it',
  )

  const committed = await hub.receive('c2', [
    frame('REFRESH', { s: 'results', epoch: 'e-1', commit: 'true' }),
  ])
  assert.ok(
    committed.some((f) => f.kind === 'HTML'),
    'and the markup arrives when the epoch does',
  )
  assert.ok(committed.some((f) => f.kind === 'COMMIT'))
})

test('a region that degraded over a channel sends its fallback, not a silence', async () => {
  const composer = createComposer({
    ports: ports([{ region: 'results', executor: 'inline' }]),
    local: {
      results: () =>
        regionStream({ region: 'results', hops: 0 }, [
          frame('ERROR', { s: 'results', code: 'E_UPSTREAM', reason: 'the index is rebuilding' }),
        ]),
    },
  })
  const regions = channelRegions({
    composer,
    regions: {
      results: { region: 'results', onExceed: 'fallback', fallback: utf8.encode('<ul data-degraded></ul>') },
    },
  })
  const hub = createHub({ store: memoryStore(), source: (request) => regions(request) })
  await negotiated(hub, 'c3')

  const out = await hub.receive('c3', [frame('REFRESH', { s: 'results' })])

  assert.equal(text.decode(out[0]?.body as Uint8Array), '<ul data-degraded></ul>')
})

test('a slot that is not a region is left to whoever else answers slots', async () => {
  const composer = createComposer({ ports: ports([]) })
  const regions = channelRegions({ composer, regions: {} })
  const hub = createHub({ store: memoryStore(), source: (request) => regions(request) })
  await negotiated(hub, 'c4')

  const out = await hub.receive('c4', [frame('REFRESH', { s: 'prices' })])

  assert.equal(str(out[0] as Frame, 'code'), 'E_NO_SUCH_SLOT', 'a null answer is not an empty one')
})

/**
 * A composite tree, which is the half of "hops are counted, not discovered" that was only a number.
 *
 * A region's own regions are resolved by its own registry — right, and the reason nothing above it
 * could name them. So a region says what it composed when it is asked what it is, and the checks
 * below are the ones that matter for a claim one deployment makes about another: the shape, the
 * depth, the size, and whether the graph and the count are the same claim.
 */
test('a probed region answers with its subtree, and the tree and the hop count agree', () => {
  const tree = [
    { region: 'results', executor: 'binding:results', hops: 1, contract: 'results@1.0.0' },
    { region: 'ads', executor: 'inline', hops: 0 },
  ]
  const bytes = regionProbeStream({ region: 'shelf', hops: 1 }, tree)

  const read = readRegion('shelf', bytes, undefined)
  assert.equal(read.announced.hops, 1, 'the count is still a header, because a page needs only that')
  assert.equal(read.html.length, 0, 'a probe renders nothing')
  assert.deepEqual(readRegionTree('shelf', bytes), tree)
})

test('a region that composes nothing answers with no subtree and no body', () => {
  const bytes = regionProbeStream({ region: 'search', hops: 0 }, [])
  assert.deepEqual(readRegionTree('search', bytes), [], 'an empty tree is an answer, not a silence')
  assert.ok(bytes.length < 40, 'and a leaf pays no bytes for a shape it does not have')
})

test('a tree that does not add up to the number beside it is refused', () => {
  // The number is what a plan's ceiling was checked against. Two claims about the same topology
  // cannot disagree, and until a region could describe its shape there was nothing to disagree with.
  const bytes = regionProbeStream({ region: 'shelf', hops: 1 }, [
    { region: 'results', executor: 'binding:results', hops: 2 },
  ])
  assert.throws(
    () => readRegionTree('shelf', bytes),
    /E_REGION_TREE.*announced 1 hop\(s\) and a tree crossing 2/,
  )
})

test('a subtree that is not a shape, is too deep, or is too big is refused rather than walked', () => {
  assert.throws(() => readRegionTree('shelf', stream('{')), /E_REGION_TREE.*not JSON/)
  assert.throws(() => readRegionTree('shelf', stream('{"region":"x"}')), /E_REGION_TREE.*not a list/)
  assert.throws(() => readRegionTree('shelf', stream('[{"executor":"inline"}]')), /naming no region/)
  assert.throws(
    () => readRegionTree('shelf', stream('[{"region":"x","executor":"i"}]')),
    /hop count of 'undefined'/,
  )

  // Nine tiers of one node each. A composite that walked an arbitrary depth on the strength of a
  // length prefix is doing what every parser that trusted a nesting depth has done.
  let deep = '[{"region":"n9","executor":"inline","hops":0}]'
  for (let i = 8; i >= 1; i--) deep = `[{"region":"n${i}","executor":"inline","hops":0,"children":${deep}}]`
  assert.throws(() => readRegionTree('shelf', stream(deep)), /E_REGION_TREE.*tiers deep/)

  const wide = JSON.stringify(
    Array.from({ length: 257 }, (_, i) => ({ region: `r${i}`, executor: 'inline', hops: 0 })),
  )
  assert.throws(() => readRegionTree('shelf', stream(wide)), /more than 256 regions/)
})

/** A hand-built answer, so a badly behaved region is something this test can produce. */
function stream(body: string, hops = 0): Uint8Array {
  return encodeStream([
    { ...announceRegion({ region: 'shelf', hops }), body: utf8.encode(body), bodyIsText: true },
  ]) as Uint8Array
}

test('what a composer composed is a graph, and a degraded region is a node that says so', async () => {
  const composer = createComposer({
    ports: ports([
      { region: 'search', executor: 'inline' },
      { region: 'recs', executor: 'inline' },
    ]),
    local: {
      search: () =>
        regionStream({ region: 'search', hops: 0, contract: { id: 'search', version: '2.1.0' } }, []),
      recs: () =>
        regionStream({ region: 'recs', hops: 0 }, [
          frame('ERROR', { s: 'recs', code: 'E_UPSTREAM', reason: 'the model service is down' }),
        ]),
    },
  })
  await composer.compose({ region: 'search' })
  await composer.compose({ region: 'recs' })

  assert.deepEqual(regionGraph(composer.composed), [
    { region: 'search', executor: 'inline', hops: 0 },
    { region: 'recs', executor: 'inline', hops: 0, failed: 'E_UPSTREAM' },
  ])
  assert.equal(treeHops(regionGraph(composer.composed)), composer.hops)
})

test('a region may say its own hole is stale, and may not say a sibling’s is', () => {
  const own = readRegion('search', answer('search', [frame('STALE', { s: 'search', reason: 'tag:index' })]))
  assert.equal(own.frames.length, 1)
  assert.equal(own.frames[0]?.kind, 'STALE')

  assert.throws(
    () => readRegion('search', answer('search', [frame('STALE', { s: 'cart' })])),
    /E_REGION_ESCAPE/,
  )
})
