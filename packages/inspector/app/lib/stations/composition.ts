import { createComposer, regionStream, type Ports, type RegionBinding, type RegionSpec } from '@weft/kernel'
import {
  bindingExecutor,
  cookieSession,
  manifestRegistry,
  memoryStore,
  regionService,
  staticFlags,
  svcExecutor,
} from '@weft/adapters'
import { escapeHtml, field, panel, pick, pre, press, readout } from '../pages.ts'
import { control, type StationHandler } from './kind.ts'

/**
 * Composition, with the region on the other side of a real boundary.
 *
 * The station exists to make one claim touchable and one claim falsifiable. The touchable one is
 * that a region moves between topologies without changing: pick `inline` and the region renders in
 * this process, pick `binding` and it renders through a real `fetch` handler, and the markup that
 * lands in the hole is byte-identical. The falsifiable one is the check — every misbehaving region
 * below is a real module on the real other side, not a hand-built frame stream, so the refusal you
 * see is the refusal a deployment would get.
 */
const utf8 = new TextEncoder()

/** The region modules, on the other side of the boundary, resolved the way a service resolves them. */
const REGIONS = new URL('../../../../adapters/fixtures/regions.ts', import.meta.url).pathname

const BEHAVIOUR = [
  'well-behaved',
  'announces another region',
  'writes into the cart',
  'a version ahead',
  'throws',
] as const

type Behaviour = (typeof BEHAVIOUR)[number]

const EXPORTS: Record<Behaviour, string> = {
  'well-behaved': 'search',
  'announces another region': 'recs',
  'writes into the cart': 'nosy',
  'a version ahead': 'searchAhead',
  throws: 'broken',
}

const WHERE = ['inline', 'binding', 'svc (nothing listening)'] as const

function ports(binding: RegionBinding): Ports {
  const registry = manifestRegistry([], { regions: [binding] })
  return {
    store: memoryStore(),
    session: cookieSession({ cookie: 'sid' }),
    flags: staticFlags({ axes: {} }),
    registry,
    executors: {
      'binding:region': bindingExecutor({ binding: regionService({ revision: 'search-42' }) }),
      // Port one never listens, so this is a connection refused rather than a slow answer.
      'svc:region': svcExecutor({ url: 'http://127.0.0.1:1/region', timeoutMs: 150 }),
    },
  }
}

/** The monolith's copy: the same fragment, called rather than posted to. */
function local(q: string): Uint8Array {
  return regionStream({ region: 'search', hops: 0, contract: { id: 'search', version: '2.1.0' } }, [
    {
      kind: 'HTML',
      header: { s: 'search' },
      body: utf8.encode(`<form role=search><input value="${escapeHtml(q)}"></form>`),
      bodyIsText: true,
    },
  ])
}

export const composition: StationHandler = async (ctx) => {
  const where = control(ctx, 'where', 'binding')
  const behaviour = control(ctx, 'behaviour', 'well-behaved') as Behaviour
  const q = control(ctx, 'q', 'sumac')
  const strict = control(ctx, 'contract', 'checked') === 'checked'

  const executor = where === 'inline' ? 'inline' : where.startsWith('svc') ? 'svc:region' : 'binding:region'
  const binding: RegionBinding = {
    region: 'search',
    executor,
    ...(executor === 'inline'
      ? {}
      : { address: { module: REGIONS, export: EXPORTS[behaviour] }, revision: 'search-42' }),
  }

  const spec: RegionSpec = {
    region: 'search',
    onExceed: 'fallback',
    fallback: utf8.encode('<form role=search data-degraded></form>'),
    ...(strict ? { contract: { id: 'search', version: '2.1.0' } } : {}),
  }

  const composer = createComposer({
    ports: ports(binding),
    local: { search: () => local(q) },
  })
  const outcome = await composer.compose(spec, { route: '/s/composition', params: { q } })

  // The same region in this process, every time, so the comparison above is against something
  // rather than against the last render of itself.
  const monolith = createComposer({
    ports: ports({ region: 'search', executor: 'inline' }),
    local: { search: () => local(q) },
  })
  const here = await monolith.compose({ region: 'search' }, { route: '/s/composition', params: { q } })
  const identical =
    here.bytes.length === outcome.bytes.length && here.bytes.every((b, i) => b === outcome.bytes[i])

  return {
    panel: panel(
      [
        field('the region runs', pick('c-where', [...WHERE], where)),
        field('and it is', pick('c-behaviour', [...BEHAVIOUR], behaviour)),
        field('contract', pick('c-contract', ['checked', 'not checked'], strict ? 'checked' : 'not checked')),
        field('query', pick('c-q', ['sumac', 'barhi', 'ceylon'], q)),
        press('c-go', 'compose it'),
      ].join(''),
      'Every option here is a real module on the real other side of a real boundary. The refusals are the ones a deployment would get, not a description of them.',
    ),
    body: async () =>
      `<div class="card"><h3>What landed in the hole</h3>${pre(
        new TextDecoder().decode(outcome.bytes) || '(nothing — an optional region that failed)',
      )}</div>`,
    readout: () =>
      readout(
        'One region, one boundary',
        [
          {
            label: 'executor',
            value: outcome.executor,
            note:
              outcome.executor === 'inline'
                ? 'this process: the monolith, and the same executor every other slot takes'
                : 'a separate crash domain, so a budget here is a deadline on waiting rather than a limit on work',
          },
          {
            label: 'hops',
            value: String(outcome.hops),
            note: 'boundaries crossed, counted rather than discovered under load',
            state: outcome.hops === 0 ? 'within' : 'plain',
          },
          {
            label: 'outcome',
            value: outcome.failure?.code ?? 'composed',
            note: outcome.failure
              ? escapeHtml(outcome.failure.message)
              : 'the region answered and the check passed',
            state: outcome.failure ? 'over' : 'within',
          },
          {
            label: 'same bytes as in-process',
            value: identical ? 'yes' : 'no',
            note: identical
              ? 'the topology is a registry field, not a second render path'
              : 'this region is not the well-behaved one, so it degraded to its declared fallback rather than rendering',
            state: identical ? 'within' : 'plain',
          },
          {
            label: 'frames for the client',
            value: outcome.frames.length ? outcome.frames.map((f) => f.kind).join(', ') : 'none',
            note: 'markup goes in the hole; what a client needs to adopt it goes to the client. Nothing from a refused region reaches either',
          },
          {
            label: 'revision',
            value: outcome.revision ?? 'not stated',
            note: 'from the region’s own announcement, which is also where the contract comes from',
          },
        ],
        {
          what: `A region resolved through the registry and rendered where the registry says it lives. The check on arrival is what makes this safe rather than convenient: a region announces itself, may write only into its own hole, and may not send a frame that belongs to whoever owns the page.`,
          from: 'createComposer() and readRegion() in @weft/kernel, against regionService() in @weft/adapters',
          caveat:
            'A region over a live channel is not wired yet, so this is the document path. The contract check here is per response; the deploy-time one that queries every region does not exist.',
          tryThis:
            'Pick “announces another region”. That is a registry entry pointing `search` at the deployment serving recommendations, and it is refused by the shell rather than rendered into the wrong hole.',
        },
      ),
  }
}
