import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, test } from 'node:test'
import {
  createComposer,
  probeRegions,
  readRegion,
  readRegionTree,
  regionProbe,
  regionStream,
  type Ports,
  type RegionRequest,
} from '@weftjs/kernel'
import {
  bindingExecutor,
  collectingTelemetry,
  cookieSession,
  manifestRegistry,
  memoryStore,
  regionService,
  staticFlags,
  svcExecutor,
  type ManifestRegistry,
} from '../src/index.ts'
import { search } from '../fixtures/regions.ts'

const FIXTURES = new URL('../fixtures/', import.meta.url).href
const text = new TextDecoder()

/**
 * Composition against a real other side: a real `fetch` handler over a binding, and a real HTTP
 * server on a real port over a service. A mock region would prove the interface is satisfiable,
 * which was never the question — what is in doubt is whether the frames survive a boundary and
 * whether the checks fire on a service that is behaving badly rather than on a hand-built stream.
 */
const servers: { close(): Promise<void> }[] = []
after(async () => {
  for (const server of servers) await server.close()
})

function ports(registry: ManifestRegistry, executors: Ports['executors'] = {}): Ports {
  return {
    store: memoryStore(),
    telemetry: collectingTelemetry(),
    session: cookieSession({ cookie: 'sid' }),
    flags: staticFlags({ axes: {} }),
    executors,
    registry,
  }
}

async function listen(handler: (request: Request) => Promise<Response>): Promise<string> {
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const response = await handler(
        new Request(`http://localhost${req.url ?? '/'}`, { method: 'POST', body: Buffer.concat(chunks) }),
      )
      res.writeHead(response.status, {
        'content-type': response.headers.get('content-type') ?? 'application/octet-stream',
      })
      res.end(Buffer.from(await response.arrayBuffer()))
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address === 'string' || !address) throw new Error('no address')
  servers.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
  return `http://127.0.0.1:${address.port}/region`
}

test('the same region composed in this process and over a binding produces the same markup', async () => {
  // The claim the design's four topologies rest on: same build output, different deployment shape.
  // If this is not byte-identical then "the collapsed monolith is the same path" is a slogan.
  const request: RegionRequest = { route: '/search', params: { q: 'sumac' } }

  const monolith = createComposer({
    ports: ports(manifestRegistry([], { regions: [{ region: 'search', executor: 'inline' }] })),
    local: { search: (r) => local(r) },
  })
  const split = createComposer({
    ports: ports(
      manifestRegistry([], {
        regions: [
          {
            region: 'search',
            executor: 'binding:search',
            address: { module: './regions.ts', export: 'search' },
          },
        ],
      }),
      { 'binding:search': bindingExecutor({ binding: regionService({ root: FIXTURES }) }) },
    ),
  })

  const here = await monolith.compose({ region: 'search' }, request)
  const there = await split.compose({ region: 'search' }, request)

  assert.equal(here.failure, undefined)
  assert.equal(there.failure, undefined)
  assert.deepEqual([...there.bytes], [...here.bytes])
  assert.match(text.decode(there.bytes), /value="sumac"/)
  assert.equal(here.hops, 0, 'a monolith crosses nothing')
  assert.equal(there.hops, 1, 'and a binding is one boundary, stated rather than discovered')
})

/**
 * The monolith's copy of the region: the same module, called rather than posted to.
 *
 * Written out rather than borrowed from the service, so the test states both sides itself and the
 * byte equality above is a real comparison instead of two calls to one function.
 */
function local(request: RegionRequest): Uint8Array {
  return regionStream({ region: search.region, hops: 0, contract: search.contract }, [
    {
      kind: 'HTML',
      header: { s: search.region },
      body: new TextEncoder().encode(search.render(request)),
      bodyIsText: true,
    },
  ])
}

test('a region over a real socket is a region, and its frames arrive with its markup', async () => {
  const url = await listen(regionService({ root: FIXTURES, revision: 'results-7' }))
  const composer = createComposer({
    ports: ports(
      manifestRegistry([], {
        regions: [
          {
            region: 'results',
            executor: 'svc:results',
            address: { module: './regions.ts', export: 'results' },
          },
        ],
      }),
      { 'svc:results': svcExecutor({ url }) },
    ),
  })

  const outcome = await composer.compose({ region: 'results' })

  assert.equal(outcome.failure, undefined)
  assert.equal(text.decode(outcome.bytes), '<ul><li>one</li></ul>')
  assert.deepEqual(
    outcome.frames.map((f) => f.kind),
    ['TPL', 'CSS'],
    'markup goes in the hole; what the client needs to adopt it goes to the client',
  )
  assert.equal(outcome.revision, 'results-7', 'which build answered, from the region itself')
})

test('rolling a region is a registry write, and the shell that composes it is untouched', async () => {
  const first = await listen(regionService({ root: FIXTURES, revision: 'search-41' }))
  const second = await listen(regionService({ root: FIXTURES, revision: 'search-42' }))
  const registry = manifestRegistry([], {
    regions: [{ region: 'search', executor: 'svc:a', address: { module: './regions.ts', export: 'search' } }],
  })
  const composer = createComposer({
    ports: ports(registry, { 'svc:a': svcExecutor({ url: first }), 'svc:b': svcExecutor({ url: second }) }),
  })

  assert.equal((await composer.compose({ region: 'search' })).revision, 'search-41')
  registry.roll({
    region: 'search',
    executor: 'svc:b',
    address: { module: './regions.ts', export: 'search' },
  })
  assert.equal((await composer.compose({ region: 'search' })).revision, 'search-42')
})

test('a registry pointing one region at another region’s deployment is refused by the shell', async () => {
  const composer = createComposer({
    ports: ports(
      manifestRegistry([], {
        regions: [
          {
            region: 'search',
            executor: 'binding:oops',
            // The deployment that serves recommendations, reached by the name `search`.
            address: { module: './regions.ts', export: 'recs' },
          },
        ],
      }),
      { 'binding:oops': bindingExecutor({ binding: regionService({ root: FIXTURES }) }) },
    ),
  })

  const outcome = await composer.compose({ region: 'search', onExceed: 'placeholder' })

  assert.equal(outcome.failure?.code, 'E_REGION_ESCAPE')
  assert.equal(outcome.bytes.length, 0)
})

test('a real service that writes into a sibling’s hole is refused with the frames still on the floor', async () => {
  const composer = createComposer({
    ports: ports(
      manifestRegistry([], {
        regions: [
          {
            region: 'search',
            executor: 'binding:nosy',
            address: { module: './regions.ts', export: 'nosy' },
          },
        ],
      }),
      { 'binding:nosy': bindingExecutor({ binding: regionService({ root: FIXTURES }) }) },
    ),
  })

  const outcome = await composer.compose({ region: 'search' })

  assert.equal(outcome.failure?.code, 'E_REGION_ESCAPE')
  assert.match(outcome.failure?.message ?? '', /'cart'/)
  assert.equal(outcome.frames.length, 0, 'nothing from a refused region reaches a client')
})

test('a region serving a version this shell was not built against degrades on its own contract', async () => {
  const composer = createComposer({
    ports: ports(
      manifestRegistry([], {
        regions: [
          {
            region: 'search',
            executor: 'binding:ahead',
            address: { module: './regions.ts', export: 'searchAhead' },
          },
        ],
      }),
      { 'binding:ahead': bindingExecutor({ binding: regionService({ root: FIXTURES }) }) },
    ),
  })

  const outcome = await composer.compose({
    region: 'search',
    contract: { id: 'search', version: '2.1.0' },
    onExceed: 'fallback',
    fallback: new TextEncoder().encode('<form role=search></form>'),
  })

  assert.equal(outcome.failure?.code, 'E_REGION_CONTRACT')
  assert.equal(text.decode(outcome.bytes), '<form role=search></form>')
})

test('a region whose render threw says so in its own frames, and the page keeps its shape', async () => {
  const composer = createComposer({
    ports: ports(
      manifestRegistry([], {
        regions: [
          {
            region: 'search',
            executor: 'binding:broken',
            address: { module: './regions.ts', export: 'broken' },
          },
        ],
      }),
      { 'binding:broken': bindingExecutor({ binding: regionService({ root: FIXTURES }) }) },
    ),
  })

  const outcome = await composer.compose({ region: 'search' })

  assert.equal(outcome.failure?.code, 'E_REGION_FAILED')
  assert.match(outcome.failure?.message ?? '', /index is rebuilding/)
})

test('a module that is not a region says which export it was asked for', async () => {
  const composer = createComposer({
    ports: ports(
      manifestRegistry([], {
        regions: [
          {
            region: 'search',
            executor: 'binding:nope',
            address: { module: './regions.ts', export: 'notARegion' },
          },
        ],
      }),
      { 'binding:nope': bindingExecutor({ binding: regionService({ root: FIXTURES }) }) },
    ),
  })

  const outcome = await composer.compose({ region: 'search' })

  assert.equal(outcome.failure?.code, 'E_SLOT_FAILED')
  assert.match(outcome.failure?.message ?? '', /422/)
})

test('a region on a deployment that is not there degrades, and the composite is still a page', async () => {
  const composer = createComposer({
    ports: ports(
      manifestRegistry([], {
        regions: [
          {
            region: 'recs',
            executor: 'svc:recs',
            address: { module: './regions.ts', export: 'recs' },
          },
        ],
      }),
      // Port one never listens, so this is a connection refused rather than a slow answer.
      { 'svc:recs': svcExecutor({ url: 'http://127.0.0.1:1/region', timeoutMs: 200 }) },
    ),
  })

  const outcome = await composer.compose({ region: 'recs' })

  assert.equal(outcome.failure?.code, 'E_SLOT_FAILED')
  assert.equal(outcome.bytes.length, 0, 'optional, so the hole is empty and the page is fine')
})

/**
 * A tier that is itself a composite, over a real boundary in both directions.
 *
 * `shelf` resolves `results` through its own registry and runs it over its own binding, which is
 * the arrangement the deployment above cannot see into: `results` is not a name it could resolve.
 * So there are two things to check and they are different. On the render path the shelf reports a
 * hop count it **measured** rather than one it was configured with. On the probe path it reports
 * the **shape**, by asking the tier below the same question it was asked.
 */
function shelfPorts(): Ports {
  return ports(
    manifestRegistry([], {
      regions: [
        {
          region: 'shelf',
          executor: 'binding:shelf',
          address: { module: './regions.ts', export: 'shelf' },
          contract: { id: 'shelf', version: '1.0.0' },
        },
      ],
    }),
    { 'binding:shelf': bindingExecutor({ binding: regionService({ root: FIXTURES }) }) },
  )
}

test('a region that composes a region reports the boundaries it crossed, not the ones it declared', async () => {
  const composer = createComposer({ ports: shelfPorts() })
  const outcome = await composer.compose({ region: 'shelf' })

  assert.equal(outcome.failure, undefined)
  assert.match(text.decode(outcome.bytes), /<section><ul><li>one<\/li><\/ul><\/section>/)
  // One to reach the shelf, one for the shelf to reach the results tier. The second was invisible
  // to this deployment until the shelf counted it, and it is counted rather than configured.
  assert.equal(outcome.hops, 2)
  assert.equal(composer.hops, 2)
})

test('a probed region asks the tier below it, so a composite answers as one graph', async () => {
  const ports_ = shelfPorts()
  const binding = ports_.registry?.region?.('shelf')
  assert.ok(binding && 'executor' in binding)

  const bytes = await regionProbe(ports_)(binding)
  const answer = readRegion('shelf', bytes, undefined)

  assert.equal(answer.html.length, 0, 'a probe is not a render, and a probe of a composite is not two')
  assert.equal(answer.announced.contract?.id, 'shelf')
  assert.deepEqual(readRegionTree('shelf', bytes), [
    { region: 'results', executor: 'binding:results', hops: 1, revision: 'results-9' },
  ])
  assert.equal(answer.announced.hops, 1, 'and the count is what the shape adds up to')
})

test('the walk is bounded from the side that started it, so two tiers composing each other terminate', async () => {
  // Depth is spent by whoever asked rather than trusted to every deployment in the chain. At zero
  // the answer is a named node: a graph that stopped without saying so would read as complete.
  const ports_ = shelfPorts()
  const tree = await probeRegions(ports_, ['shelf'], 0)
  assert.deepEqual(tree, [{ region: 'shelf', executor: 'unresolved', hops: 0, failed: 'E_REGION_TOO_DEEP' }])
})
