import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assertValidTemplate,
  draftTemplate,
  seal,
  type EffectSet,
  type TemplateIR,
  type Values,
} from '@weft/ir'
import { createKernel, type Ports } from '@weft/kernel'
import {
  bindingExecutor,
  cookieSession,
  manifestRegistry,
  memoryStore,
  regionService,
  staticFlags,
  svcExecutor,
  topology,
} from '@weft/adapters'
import {
  cspOf,
  hopsOf,
  lowerPlan,
  plan,
  region,
  regionProbe,
  shell,
  slot,
  validatePlan,
  verifyRegions,
  why,
  type PlanEntry,
  type SlotFacts,
} from '../src/index.ts'

/**
 * The shell DSL: a plan whose leaves may live somewhere else.
 *
 * A region is a slot, so most of what a plan already checks applies to one without being told —
 * that it fills a hole the shell leaves, that its `needs` name real slots, that a public document
 * cannot contain a private region. What is tested here is the part that is new: the declarations
 * only a region has, the three ways they can contradict themselves, and the two numbers a build can
 * state about a fan-out that a deployment would otherwise discover under load.
 */
function effects(reads: string[]): EffectSet {
  return { reads: [...reads].sort(), writes: [], envelope: [], residency: reads.length ? 'server' : 'either' }
}

function facts(reads: string[] = [], extra: Partial<SlotFacts> = {}): SlotFacts {
  return {
    id: 'fragment',
    version: 'v1',
    effects: effects(reads),
    forms: ['html', 'bundle', 'split', 'patch', 'delta'],
    ...extra,
  }
}

const SHELL = 'shell.tsx#default'

function route(
  entries: PlanEntry[],
  f: Record<string, SlotFacts> = {},
  options: Parameters<typeof plan>[2] = {},
): { plan: ReturnType<typeof plan>; facts: Record<string, SlotFacts> } {
  const names = entries.filter((e) => 'spec' in e).map((e) => ('spec' in e ? e.spec.name : ''))
  return {
    plan: plan('/', [shell(SHELL), ...entries], options),
    facts: { ...f, [SHELL]: facts([], { fillable: names }) },
  }
}

test('a region is a slot, so a shell composing one is a plan and not a second thing', () => {
  const chrome = region('chrome').local('chrome.tsx#default').critical()
  const built = route([chrome], { 'chrome.tsx#default': facts() })
  const diagnostics = validatePlan(built.plan, { facts: built.facts })

  assert.deepEqual(diagnostics.errors, [])
  assert.equal(chrome.spec.executor, 'region', 'where it runs is the registry’s answer')
  assert.equal(chrome.spec.region?.locus, 'local')
})

test('a remote region has no fragment here, and that absence is expected rather than an error', () => {
  const search = region('search').remote({ id: 'search', version: '2.1.0', reads: ['locale'] })
  const built = route([search])
  const diagnostics = validatePlan(built.plan, { facts: built.facts })

  assert.deepEqual(
    diagnostics.errors.filter((e) => e.code === 'E_NO_SUCH_FRAGMENT'),
    [],
    'the template is on the other side; the contract is what stands in for the compiler',
  )
})

test('a local region declaring a contract is refused, because there is a compiler here to disagree with', () => {
  const built = route([region('chrome').local('chrome.tsx#default').contract('chrome', '1.0.0')], {
    'chrome.tsx#default': facts(),
  })
  const diagnostics = validatePlan(built.plan, { facts: built.facts })

  assert.ok(diagnostics.errors.some((e) => e.code === 'E_REGION_CONTRACT_LOCAL'))
})

test('a critical region cannot be remote, because critical means it is in the first flush', () => {
  const built = route([region('chrome').remote().critical()])
  const diagnostics = validatePlan(built.plan, { facts: built.facts })

  assert.ok(diagnostics.errors.some((e) => e.code === 'E_REGION_CRITICAL_REMOTE'))
})

test('a region consuming a signal the shell does not expose fails the build with both named', () => {
  const built = route(
    [region('search').remote().consumes('locale', 'cartCount')],
    {},
    { exposes: ['locale'] },
  )
  const diagnostics = validatePlan(built.plan, { facts: built.facts })

  const issue = diagnostics.errors.find((e) => e.code === 'E_NOT_EXPOSED')
  assert.ok(issue, 'the exposed set is the only channel between regions, so it can be checked')
  assert.match(issue?.message ?? '', /cartCount/)
})

test('the executor sentinel belongs to regions, and a slot claiming it has named nothing', () => {
  const built = route([slot('body').executor('region')], { body: facts() })
  const diagnostics = validatePlan(built.plan, { facts: { ...built.facts, body: facts() } })

  assert.ok(diagnostics.errors.some((e) => e.code === 'E_UNKNOWN_EXECUTOR'))
})

test('a region that also names an executor is refused rather than one of the two winning', () => {
  const search = region('search').remote()
  search.spec.executor = 'svc:search'
  const built = route([search])
  const diagnostics = validatePlan(built.plan, { facts: built.facts })

  assert.ok(diagnostics.errors.some((e) => e.code === 'E_REGION_EXECUTOR'))
})

test('the hop count is a number the build states, and a floor rather than an estimate', () => {
  const built = route(
    [
      region('chrome').local('chrome.tsx#default'),
      region('search').remote({ id: 'search', version: '2.1.0' }),
      region('recs').remote({ id: 'recs', version: '0.4.0' }).optional(),
    ],
    { 'chrome.tsx#default': facts() },
  )

  assert.deepEqual(hopsOf(built.plan), { regions: 3, remote: 2, hops: 2 })
  const report = why({ plan: built.plan, facts: built.facts })
  assert.match(report.text, /regions        3 \| remote 2 \| worst-case hops 2/)
  assert.match(report.text, /a floor/)
})

test('a fan-out approaching the platform’s subrequest ceiling is a warning before it arrives', () => {
  const many = Array.from({ length: 9 }, (_, i) => region(`r${i}`).remote())
  const built = route(many)
  const diagnostics = validatePlan(built.plan, { facts: built.facts, subrequestCeiling: 10 })

  const warning = diagnostics.warnings.find((w) => w.code === 'W_HOP_COUNT')
  assert.ok(warning)
  assert.match(warning?.message ?? '', /9 deployment boundaries/)
})

test('a public document containing a region nobody described is refused, not advertised', () => {
  const undescribed = route(
    [region('search').remote({ id: 'search', version: '2.1.0' })],
    {},
    {
      cache: { class: 'public', ttl: '60s' },
    },
  )
  const first = validatePlan(undescribed.plan, { facts: undescribed.facts })
  assert.ok(
    first.errors.some((e) => e.code === 'E_DOCUMENT_POLICY_CONFLICT'),
    'unknown reads are not no reads',
  )

  const described = route(
    [region('search').remote({ id: 'search', version: '2.1.0', reads: ['locale'] })],
    {},
    { cache: { class: 'public', ttl: '60s' } },
  )
  const second = validatePlan(described.plan, { facts: described.facts })
  assert.deepEqual(
    second.errors.filter((e) => e.code === 'E_DOCUMENT_POLICY_CONFLICT'),
    [],
    'a region that says what it reads can be part of a shareable page',
  )

  const personal = route(
    [region('search').remote({ id: 'search', version: '2.1.0', reads: ['identity'] })],
    {},
    { cache: { class: 'public', ttl: '60s' } },
  )
  assert.ok(
    validatePlan(personal.plan, { facts: personal.facts }).errors.some(
      (e) => e.code === 'E_DOCUMENT_POLICY_CONFLICT',
    ),
    'and one that reads identity cannot, exactly as a local fragment could not',
  )
})

test('the regions’ policies merge into the one header a document has', () => {
  const built = route([
    region('search')
      .remote()
      .csp({ 'connect-src': ["'self'", 'https://search.internal'] }),
    region('recs')
      .remote()
      .csp({ 'connect-src': ['https://recs.internal'], 'img-src': ['https://cdn'] }),
  ])

  assert.deepEqual(cspOf(built.plan), {
    'connect-src': ["'self'", 'https://recs.internal', 'https://search.internal'],
    'img-src': ['https://cdn'],
  })
})

test('one region refusing everything and another naming a host is a conflict, not a union', () => {
  const built = route([
    region('search')
      .remote()
      .csp({ 'connect-src': ["'none'"] }),
    region('recs')
      .remote()
      .csp({ 'connect-src': ['https://recs.internal'] }),
  ])
  const diagnostics = validatePlan(built.plan, { facts: built.facts })

  const issue = diagnostics.errors.find((e) => e.code === 'E_CSP_CONFLICT')
  assert.ok(issue, "'none' is the one value that means and nothing else")
  assert.match(issue?.message ?? '', /search, recs|recs, search/)
})

/**
 * The whole seam, once, against a real other side: a shell with two regions — one this process
 * renders, one on the far side of a real `fetch` handler — lowered into a route and served by the
 * real kernel.
 *
 * Everything above is a check on a declaration. This is the check that the declaration produces a
 * document: two regions in two holes, the remote one's markup carried over a boundary, and the
 * merged policy on a header that was written while the envelope was still open.
 */
const REGIONS = new URL('../../adapters/fixtures/regions.ts', import.meta.url).pathname

async function composedShell(): Promise<TemplateIR> {
  return assertValidTemplate(
    await seal(
      draftTemplate({
        id: 'shell/app',
        segments: ['<header>', '</header><main>', '</main>'],
        holes: [
          { index: 0, kind: 'slot', escape: 'escape', binding: 'chrome', path: [0] },
          { index: 1, kind: 'slot', escape: 'escape', binding: 'search', path: [1] },
        ],
      }),
    ),
  )
}

async function chromeFragment(): Promise<TemplateIR> {
  return assertValidTemplate(
    await seal(
      draftTemplate({
        id: 'fragment/chrome',
        segments: ['<nav>', '</nav>'],
        holes: [{ index: 0, kind: 'text', escape: 'escape', binding: 'label', path: [0] }],
      }),
    ),
  )
}

test('a shell with a local region and a remote one is one document, and the policy is one header', async () => {
  const shellIR = await composedShell()
  const chromeIR = await chromeFragment()

  const composed = plan(
    '/app',
    [
      shell('shell/app'),
      region('chrome')
        .local('fragment/chrome')
        .critical()
        .csp({ 'img-src': ["'self'"] }),
      region('search')
        .remote({ id: 'search', version: '2.1.0', reads: ['route:q'] })
        .csp({ 'connect-src': ['https://search.internal'] })
        .fallback('static:search-placeholder'),
    ],
    { exposes: ['locale'] },
  )

  const context = {
    facts: {
      'shell/app': facts([], { fillable: ['chrome', 'search'] }),
      'fragment/chrome': facts(),
    },
  }
  assert.deepEqual(validatePlan(composed, context).errors, [])

  const ports: Ports = {
    store: memoryStore(),
    session: cookieSession({ cookie: 'sid' }),
    flags: staticFlags({ axes: {} }),
    executors: { 'binding:search': bindingExecutor({ binding: regionService({ revision: 'search-42' }) }) },
    registry: manifestRegistry([], {
      regions: [
        { region: 'chrome', executor: 'inline' },
        {
          region: 'search',
          executor: 'binding:search',
          address: { module: REGIONS, export: 'search' },
          contract: { id: 'search', version: '2.1.0', reads: ['route:q'] },
        },
      ],
    }),
  }

  const resolver = lowerPlan(composed, context, {
    shell: { entry: shellIR },
    slots: {
      chrome: {
        fragment: { entry: chromeIR },
        values: () => ({ label: 'weft' }) as unknown as Values,
      },
      search: undefined as never,
    },
    regions: {
      ports,
      degraded: { search: { fallback: new TextEncoder().encode('<form role=search></form>') } },
    },
  })

  const kernel = createKernel({ ports })
  const lowered = await resolver({ q: 'sumac' })
  const response = await kernel.handle(new Request('http://localhost/app?q=sumac'), lowered, {
    q: 'sumac',
  })
  const html = await response.text()

  assert.match(html, /<nav>weft<\/nav>/, 'the local region rendered here')
  assert.match(html, /value="sumac"/, 'and the remote one rendered on the other side of a binding')
  assert.equal(
    response.headers.get('content-security-policy'),
    "connect-src https://search.internal; img-src 'self'",
    'both regions’ needs, merged, on the one header a document has',
  )
  assert.equal(
    kernel.trace?.keys['search']?.class,
    'shared',
    'the region’s class is derived from the reads its contract carries, not declared by the shell',
  )
  assert.deepEqual(
    kernel.trace?.keys['search']?.components,
    { 'route:q': 'sumac' },
    'and the composite resolved them for this request exactly as it would a local fragment’s',
  )
  assert.deepEqual(kernel.trace?.hits, [], 'nothing was stored: the plan declared no policy for it')
})

/**
 * Verification: the four facts in four places, and every pair of them able to disagree.
 *
 * These are the checks a build cannot do, because a registry is a deployment's and can be written
 * to without anybody rebuilding — and because what a region is serving is only knowable by asking
 * it.
 */
function shellWith(entries: PlanEntry[]): ReturnType<typeof plan> {
  return plan('/app', [shell(SHELL), ...entries])
}

test('a region nothing resolves is named, and so is the route that composes it', async () => {
  const report = await verifyRegions([shellWith([region('search').remote()])], {
    registry: manifestRegistry([]),
  })

  assert.equal(report.errors[0]?.code, 'E_NO_SUCH_REGION')
  assert.match(report.text, /\/app/)
})

test('a registry that makes a remote region local is refused, because the plan’s numbers assumed otherwise', async () => {
  const report = await verifyRegions([shellWith([region('search').remote()])], {
    registry: manifestRegistry([], { regions: [{ region: 'search', executor: 'inline' }] }),
  })

  const issue = report.errors.find((e) => e.code === 'E_REGION_LOCUS_MISMATCH')
  assert.ok(issue)
  assert.match(issue?.message ?? '', /hop count/)
})

test('a registry naming a tier this deployment does not bind is a startup failure, not a request-time one', async () => {
  const report = await verifyRegions([shellWith([region('search').remote()])], {
    registry: manifestRegistry([], {
      regions: [{ region: 'search', executor: 'svc:search', address: { module: REGIONS, export: 'search' } }],
    }),
    executors: [],
  })

  assert.ok(report.errors.some((e) => e.code === 'E_UNKNOWN_EXECUTOR'))
})

test('what a region is serving right now is the window CI cannot close', async () => {
  const ports: Ports = {
    store: memoryStore(),
    session: cookieSession({ cookie: 'sid' }),
    flags: staticFlags({ axes: {} }),
    executors: {
      'binding:search': bindingExecutor({ binding: regionService({ revision: 'search-42' }) }),
    },
  }
  const registry = manifestRegistry([], {
    regions: [
      {
        region: 'search',
        executor: 'binding:search',
        address: { module: REGIONS, export: 'search' },
      },
    ],
  })
  const context = { registry, executors: ['binding:search'] }

  // Built against what the fixture actually serves.
  const agreed = await verifyRegions(
    [shellWith([region('search').remote({ id: 'search', version: '2.1.0', reads: ['route:q'] })])],
    context,
    regionProbe(ports),
  )
  assert.deepEqual(agreed.errors, [])
  assert.equal(agreed.regions[0]?.serving?.contract, 'search@2.1.0')
  assert.equal(agreed.regions[0]?.serving?.revision, 'search-42')

  // Built against a version nobody is serving: the deploy that would have shipped this is the one
  // this check exists to stop.
  const skewed = await verifyRegions(
    [shellWith([region('search').remote({ id: 'search', version: '3.0.0' })])],
    context,
    regionProbe(ports),
  )
  const issue = skewed.errors.find((e) => e.code === 'E_REGION_CONTRACT')
  assert.ok(issue)
  assert.match(issue?.message ?? '', /serving search@2\.1\.0/)

  // And the same version with different reads underneath it, which is worse than a mismatch:
  // the composite would have advertised a class and a Vary derived from reads nobody serves.
  const moved = await verifyRegions(
    [shellWith([region('search').remote({ id: 'search', version: '2.1.0', reads: ['identity'] })])],
    context,
    regionProbe(ports),
  )
  assert.match(moved.errors[0]?.message ?? '', /cache class and a Vary/)
})

test('a region on a deployment that is not there is unreachable rather than silently absent', async () => {
  const ports: Ports = {
    store: memoryStore(),
    session: cookieSession({ cookie: 'sid' }),
    flags: staticFlags({ axes: {} }),
    // Port one never listens.
    executors: { 'svc:search': svcExecutor({ url: 'http://127.0.0.1:1/region', timeoutMs: 150 }) },
  }
  const report = await verifyRegions(
    [shellWith([region('search').remote({ id: 'search', version: '2.1.0' })])],
    {
      registry: manifestRegistry([], {
        regions: [
          { region: 'search', executor: 'svc:search', address: { module: REGIONS, export: 'search' } },
        ],
      }),
      executors: ['svc:search'],
    },
    regionProbe(ports),
  )

  assert.equal(report.errors[0]?.code, 'E_REGION_UNREACHABLE')
})

test('a topology is a registry and a set of executors, and it can say which one it is', () => {
  const regions = [
    { region: 'search', address: { module: REGIONS, export: 'search' }, url: 'http://search.internal/r' },
    { region: 'recs', address: { module: REGIONS, export: 'recs' }, url: 'http://recs.internal/r' },
  ]

  const mono = topology('monolith', { regions })
  assert.deepEqual(mono.registry.regions(), ['search', 'recs'])
  assert.deepEqual(Object.keys(mono.executors), [], 'nothing to reach: it is all here')
  assert.equal(mono.registry.region('search')?.executor, 'inline')

  const split = topology('split-render', { regions, render: { url: 'http://render.internal/r' } })
  assert.deepEqual(Object.keys(split.executors), ['binding:render'], 'one tier, every region')
  assert.equal(split.registry.region('recs')?.executor, 'binding:render')

  const mesh = topology('mesh', { regions })
  assert.deepEqual(Object.keys(mesh.executors).sort(), ['svc:recs', 'svc:search'], 'a tier per region')
  assert.match(mesh.describe(), /topology mesh/)

  // The one thing a topology may not do is collapse quietly: a split with nowhere to send a region
  // would be a monolith reported as a split.
  assert.throws(() => topology('split-render', { regions }), /E_NO_TIER/)
  assert.throws(
    () => topology('mesh', { regions: [{ region: 'search', url: 'http://x/r' }] }),
    /E_NO_REGION_ADDRESS/,
  )
})
