import { cacheClassOf, requiresTtl, varyOn, type EffectSet } from '@weft/ir'
import {
  cacheHeaders,
  createRouter,
  requestFacts,
  resolveKey,
  unimplemented,
  PORTS,
  type PortName,
  type Ports,
} from '@weft/kernel'
import { cookieSession, memoryStore, staticFlags } from '@weft/adapters'
import { factsFrom, plan, shell, slot, validatePlan } from '@weft/plan'
import { escapeHtml, field, panel, pick, pre, press, readout } from '../pages.ts'
import type { StationHandler } from './kind.ts'
import { allFragments, appPorts, fragmentIR } from '@weft/core'

/**
 * The introspection stations: what the compiler inferred, what the kernel derived from it, and
 * what the plan layer refuses. Nothing on these pages is written down twice — each one reads the
 * real IR of a real fragment in this repository and shows you what fell out of it.
 */
const ports = (): Ports => ({
  store: memoryStore(),
  session: cookieSession({ cookie: 'sid' }),
  flags: staticFlags({ axes: { 'new-cart': ['off', 'on'] } }),
  executors: {},
})

/**
 * The fixtures this station lets you switch between, each one a case worth seeing.
 *
 * `static` reads nothing, so its class resolves at build time. `clock` reads the clock, which is
 * what forces a ttl. `private` reads identity and a cookie, so it can never be a shared entry.
 * `identity` is the smallest fragment that changes a page's class. `composed` renders a component
 * three times, and `panels` is an ordinary list.
 */
const FRAGMENT_CHOICES = ['static', 'clock', 'private', 'identity', 'composed', 'panels'] as const

export const effects: StationHandler = async (ctx) => {
  const which = (ctx.query('fragment') ?? 'private') as (typeof FRAGMENT_CHOICES)[number]
  const target = fragmentIR(`fragment:${which}`)
  const set: EffectSet = target.entry.effects
  const cls = cacheClassOf(set)
  const vary = varyOn(set)

  return {
    panel: panel(
      [
        field('fragment', pick('effects-fragment', [...FRAGMENT_CHOICES], which)),
        press('effects-go', 'inspect'),
      ].join(''),
      'Each of these is a real file in demo/src/fragments. The read set below was inferred from it, not declared anywhere.',
    ),
    body: async () =>
      readout(
        `${target.file}`,
        [
          {
            label: 'Inferred reads',
            value: set.reads.length ? set.reads.join(', ') : 'none',
            note: 'every ctx call the compiler could name statically, and nothing else',
          },
          {
            label: 'Cache class',
            value: cls,
            note:
              cls === 'private'
                ? 'something in the read set is identity or opaque, so this can never be a shared entry'
                : cls === 'static'
                  ? 'it reads nothing, so its key is its own content address and a CDN could serve it'
                  : 'shared: keyed by the values it read, and safe for more than one person',
            state: cls === 'private' ? ('over' as const) : ('within' as const),
          },
          {
            label: 'Vary',
            value: vary.length ? vary.join(', ') : 'none',
            note: 'a shared response keyed by a request value has to say so, or a CDN serves it to everyone',
          },
          {
            label: 'TTL required',
            value: requiresTtl(set) ? 'yes' : 'no',
            note: requiresTtl(set)
              ? 'it read the clock, so a policy without a ttl is a build error — it would never expire'
              : 'no clock read, so a policy without a ttl is legitimate',
            state: requiresTtl(set) ? ('over' as const) : ('plain' as const),
          },
          {
            label: 'Wire forms',
            value: target.entry.forms.join(', '),
            note: 'derived by the compiler from the hole kinds, never declared. A slot hole rules out delta',
          },
          {
            label: 'Holes',
            value: String(target.entry.holes.length),
            note: target.entry.holes.map((h) => `${h.kind}:${h.binding}`).join(' · '),
          },
        ],
        {
          what: `What the compiler inferred from one file, and everything the kernel derives from it. The cache class, the Vary header, whether a TTL is mandatory and which wire forms are available are all consequences of the read set — none of them is a setting.`,
          from: 'compileFiles() in @weft/compiler, then cacheClassOf / varyOn / requiresTtl in @weft/ir',
          caveat:
            'It shows what the fragment reads, not what the values are. Resolving those reads against a request is the cache-keys station.',
          tryThis:
            'Compare `article` with `cart`. One reads nothing and is static; the other reads identity and can never be shared. The difference is two lines of source.',
        },
      ),
    readout: pre(target.source.split('\n').slice(0, 40).join('\n')),
  }
}

export const contagion: StationHandler = async () => {
  const shellSet = fragmentIR('layout').entry.effects
  const child = fragmentIR('fragment:identity').entry.effects
  const union: EffectSet = {
    reads: [...new Set([...shellSet.reads, ...child.reads])].sort(),
    writes: [],
    envelope: [],
    residency: 'server',
  }
  return {
    panel: panel(
      '',
      'Two real fragments: the shell every page here uses, and the greeting the cart puts in a slot.',
    ),
    body: async () =>
      readout(
        'A private child inside a shared parent',
        [
          {
            label: 'shell.tsx alone',
            value: cacheClassOf(shellSet),
            note: `reads ${shellSet.reads.length ? shellSet.reads.join(', ') : 'nothing'}`,
            state: 'within',
          },
          {
            label: 'greeting.tsx alone',
            value: cacheClassOf(child),
            note: `reads ${child.reads.join(', ')} — identity is what makes it private`,
            state: 'over',
          },
          {
            label: 'if they shared one entry',
            value: cacheClassOf(union),
            note: 'the union of their reads, which is what an inlined child would produce: the whole page becomes per-user',
            state: 'over',
          },
          {
            label: 'as a slot instead',
            value: `${cacheClassOf(shellSet)} + ${cacheClassOf(child)}`,
            note: 'two entries, two classes. The shell is shared by everyone and only the greeting is per-user',
            state: 'within',
          },
        ],
        {
          what: `What contagion costs, and what isolating an instance saves. A private fragment inlined into a shared parent makes the parent private — the third row is that page. Making it a slot means the kernel composes two cache entries at stream time, so the expensive shared bytes stay shared.`,
          from: 'cacheClassOf() in @weft/ir over the real effect sets of shell.tsx and greeting.tsx',
          caveat:
            'The compiler isolates an instance automatically when a child is private and its caller is not. This station shows the classes; the effects station shows where they came from.',
          tryThis:
            'Open /app/cart. The shell there is the same shared template as every other page on this site.',
        },
      ),
  }
}

export const cacheKeys: StationHandler = async (ctx) => {
  const currency = ctx.query('currency') ?? 'IQD'
  const tier = ctx.query('tier') ?? 'standard'
  const sid = ctx.query('sid') ?? 'demo-1'

  const request = new Request('https://demo.local/app/cart?sort=price', {
    headers: { cookie: `sid=${sid}; currency=${currency}`, 'x-tier': tier, 'accept-language': 'ar-IQ' },
  })
  const facts = requestFacts(request, { category: 'pantry' })
  const p = ports()
  const cart = await resolveKey(
    {
      id: fragmentIR('fragment:private').entry.id,
      version: fragmentIR('fragment:private').entry.version,
      effects: fragmentIR('fragment:private').entry.effects,
    },
    facts,
    p,
  )
  const article = await resolveKey(
    {
      id: fragmentIR('fragment:static').entry.id,
      version: fragmentIR('fragment:static').entry.version,
      effects: fragmentIR('fragment:static').entry.effects,
    },
    facts,
    p,
  )
  const headers = cacheHeaders(cart, { class: 'private' })

  return {
    panel: panel(
      [
        field('cookie currency', pick('key-currency', ['IQD', 'USD', 'EUR'], currency)),
        field('header x-tier', pick('key-tier', ['standard', 'gold', 'wholesale'], tier)),
        field('cookie sid', pick('key-sid', ['demo-1', 'demo-2', 'demo-3'], sid)),
        press('key-go', 'resolve'),
      ].join(''),
      'There is no key setter in this framework — not in the kernel, not in the plan DSL, not on the plugin surface. The absence is the enforcement.',
    ),
    body: async () =>
      readout(
        'The same reads, resolved against this request',
        [
          { label: 'cart.tsx key', value: cart.key ?? 'uncacheable', note: cart.reason },
          {
            label: 'components',
            value:
              Object.entries(cart.components)
                .map(([k, v]) => `${k}=${v}`)
                .join(' · ') || 'none',
            note: 'each read that changes the answer, and the value it resolved to on this request',
          },
          { label: 'class', value: cart.class, note: 'derived, not declared', state: 'over' },
          {
            label: 'Vary',
            value: cart.vary.join(', ') || 'none',
            note: 'the union the document has to advertise',
          },
          {
            label: 'Cache-Control',
            value: headers['cache-control'] ?? 'none',
            note: 'what a CDN in front of this would be told',
          },
          {
            label: 'article.tsx key',
            value: article.key ?? 'uncacheable',
            note: `${article.reason} — it read nothing, so nothing about the request is in it`,
            state: 'within',
          },
        ],
        {
          what: `A cache key resolved from what the code read. The compiler recorded which reads taint the fragment; the kernel resolved their values and hashed them with the fragment's content address. Change a control above and the key changes — which is what turns a hit into a miss, and is the only way a key ever changes.`,
          from: 'resolveKey() and cacheHeaders() in @weft/kernel, against a real Request',
          caveat:
            'These are resolved keys, not store contents. Whether a key is a hit depends on what has been written, which is the stampede station.',
          tryThis:
            'Change the sid. The cart key changes because it read identity; the article key does not move at all, because it read nothing.',
        },
      ),
  }
}

export const routing: StationHandler = async (ctx) => {
  const path = ctx.query('path') ?? '/product/new'
  const table = createRouter<string>([
    { pattern: '/', value: 'index' },
    { pattern: '/product/new', value: 'the literal, which beats the param' },
    { pattern: '/product/:sku', value: 'one product' },
    { pattern: '/app/ordinary/:category', value: 'the ordinary showcase' },
    { pattern: '/docs/*', value: 'a wildcard, which loses to both' },
  ])
  const matched = table.match(path)
  return {
    panel: panel(
      [
        field('path', `<input id="route-path" value="${escapeHtml(path)}" size="28">`),
        press('route-go', 'match'),
      ].join(''),
      'Specificity decides, never declaration order. A table whose behaviour depends on the order somebody happened to write it in is a table nobody can safely refactor.',
    ),
    body: async () =>
      readout(
        `Matching ${path}`,
        [
          {
            label: 'pattern',
            value: matched?.pattern ?? 'no match',
            note: matched
              ? 'the most specific pattern that matches'
              : 'a 404, and the trace records that nothing was planned',
            state: matched ? 'within' : 'over',
          },
          {
            label: 'value',
            value: matched?.value ?? '—',
            note: 'what the route resolves to; the kernel never learns what a plan is',
          },
          {
            label: 'params',
            value: matched ? JSON.stringify(matched.params) : '{}',
            note: 'these become cache key components through ctx.param(), without the plan mentioning keys',
          },
          {
            label: 'try order',
            value: table.patterns.join('  ›  '),
            note: 'sorted by specificity at build: static beats a param, a param beats a wildcard, segment by segment',
          },
        ],
        {
          what: `A path matched against a real route table. The order the patterns are tried in is computed when the table is built, so /product/new wins over /product/:sku without either declaring a priority.`,
          from: 'createRouter() in @weft/kernel — the same matcher every page on this site went through',
          caveat:
            'The table is path-only for documents. A method match belongs with intents, and that table is separate: see the intents station.',
          tryThis:
            'Try /product/new, then /product/rice, then /docs/anything/deep. Then try /product (no match).',
        },
      ),
  }
}

export const shellBoundaries: StationHandler = async () => {
  const facts = factsFrom(
    Object.values(allFragments()).map((fragment) => ({ fragments: [{ entry: fragment.entry }] })),
  )
  // The shell is a fragment like any other, so its boundaries reach the validator through the
  // same `facts` map. There is no second channel for shell information, which is why a shell
  // boundary check cannot disagree with the shell's own IR.
  const cases: { label: string; build: () => ReturnType<typeof validatePlan> }[] = [
    {
      label: 'every hole filled',
      build: () =>
        validatePlan(
          plan('/x', [
            shell(fragmentIR('layout').entry.id),
            slot('panel').fragment(fragmentIR('fragment:markup').entry.id),
            slot('body').fragment(fragmentIR('fragment:static').entry.id),
            slot('readout').fragment(fragmentIR('fragment:markup').entry.id),
          ]),
          { facts },
        ),
    },
    {
      label: 'a slot the shell does not leave',
      build: () =>
        validatePlan(
          plan('/x', [
            shell(fragmentIR('layout').entry.id),
            slot('panel').fragment(fragmentIR('fragment:markup').entry.id),
            slot('body').fragment(fragmentIR('fragment:static').entry.id),
            slot('readout').fragment(fragmentIR('fragment:markup').entry.id),
            slot('sidebar').fragment(fragmentIR('fragment:markup').entry.id),
          ]),
          { facts },
        ),
    },
    {
      label: 'a hole nothing fills',
      build: () =>
        validatePlan(
          plan('/x', [
            shell(fragmentIR('layout').entry.id),
            slot('panel').fragment(fragmentIR('fragment:markup').entry.id),
            slot('body').fragment(fragmentIR('fragment:static').entry.id),
          ]),
          { facts },
        ),
    },
    {
      label: 'no shell at all',
      build: () =>
        validatePlan(plan('/x', [slot('body').fragment(fragmentIR('fragment:static').entry.id)]), { facts }),
    },
    {
      label: 'public on a fragment that reads identity',
      build: () =>
        validatePlan(
          plan('/x', [
            shell(fragmentIR('layout').entry.id),
            slot('panel').fragment(fragmentIR('fragment:markup').entry.id),
            slot('body').fragment(fragmentIR('fragment:private').entry.id).cache('public', { ttl: '60s' }),
            slot('readout').fragment(fragmentIR('fragment:markup').entry.id),
          ]),
          { facts },
        ),
    },
    {
      label: 'public with no ttl on a fragment that reads the clock',
      build: () =>
        validatePlan(
          plan('/x', [
            shell(fragmentIR('layout').entry.id),
            slot('panel').fragment(fragmentIR('fragment:markup').entry.id),
            slot('body').fragment(fragmentIR('fragment:clock').entry.id).cache('public'),
            slot('readout').fragment(fragmentIR('fragment:markup').entry.id),
          ]),
          { facts },
        ),
    },
  ]

  const rows = cases.map((c) => {
    const result = c.build()
    const first = result.errors[0]
    return {
      label: c.label,
      value: first ? first.code : 'builds',
      note: first ? first.message : `${result.warnings.length} warning(s)`,
      state: first ? ('over' as const) : ('within' as const),
    }
  })

  return {
    panel: panel(
      '',
      'Every row below is a plan this process just tried to validate against the real shell. Nothing is transcribed.',
    ),
    body: async () =>
      readout('Six plans, checked against the shell the compiler produced', rows, {
        what: `The plan layer is checked against the compiler, never the reverse. A slot naming a hole the shell does not leave, a hole nothing fills, and a cache class contradicting an inferred read set are all build errors — and each one names the thing that caused it rather than saying the plan is invalid.`,
        from: 'validatePlan() in @weft/plan, against the real shell.tsx and the real fragment effect sets',
        caveat:
          'These are validation results, not lowering results. `lowerPlan` validates before it lowers, so an invalid plan cannot become a route at all.',
        tryThis:
          'Read the last two rows together. One is a class contradicting a read; the other is a policy that could never expire. Both come from the fragment, not from the plan.',
      }),
  }
}

/**
 * What each port is, when this application is the one being described.
 *
 * Read from the live record rather than reconstructed: the store row is the store that answered
 * the request that rendered this page, and the deployment row is the build serving it. A station
 * that built its own ports would be a page about a plausible application.
 */
function describe(name: PortName, bound: Ports): string {
  switch (name) {
    case 'store':
      return `${bound.store.name} · ${bound.store.consistency} · coherence ${bound.store.coherence} · scope ${bound.store.scope}`
    case 'registry':
      return 'manifestRegistry, which derives intent ids with the same function the compiler used'
    case 'executor':
      return `${Object.keys(bound.executors).length + 3} bound: inline, deferred and client always, plus what the config added`
    case 'scheduler':
      return `${bound.scheduler?.name ?? '—'}, ceiling ${bound.scheduler?.maxConcurrency ?? '—'} concurrent renders per request`
    case 'assets':
      return `${bound.assets?.name ?? '—'} — what a route's 103 carries, answered before the plan runs`
    case 'render':
      return `${bound.render?.name ?? '—'} — pre-encoded segments around escaped holes`
    case 'config':
      return `${bound.config?.name ?? '—'} · ${bound.config?.keys().length ?? 0} setting(s) visible under the prefix`
    case 'deployment':
      return `${bound.deployment?.revision ?? '—'} · ${bound.deployment?.environment ?? '—'}${bound.deployment?.region ? ` · ${bound.deployment.region}` : ''}`
    case 'db':
      return `${bound.db?.name ?? '—'} — a deadline and a name per access, and the tags it declared`
    case 'transport':
      return 'nodeTransport, per response, because 103 goes out on a socket'
    default:
      return 'bound in @weft/adapters'
  }
}

export const portsStation: StationHandler = async () => {
  const bound = appPorts()
  // Bound, rather than a list somebody keeps in step by hand: the transport is per request and
  // therefore absent from the record, so it is named separately rather than reported missing.
  const implemented = new Set<PortName>([
    ...(Object.entries(bound)
      .filter(([, value]) => Boolean(value))
      .map(([key]) => (key === 'executors' ? 'executor' : key)) as PortName[]),
    'transport',
  ])
  const rows = PORTS.map((name) => {
    if (implemented.has(name)) {
      return {
        label: name,
        value: 'implemented',
        note: describe(name, bound),
        state: 'within' as const,
      }
    }
    let refusal = ''
    try {
      unimplemented(name)
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error)
    }
    return { label: name, value: 'declared only', note: refusal, state: 'plain' as const }
  })
  return {
    panel: panel(
      '',
      `${PORTS.length} ports are declared and this deployment binds ${implemented.size}. Any that remain refuse by name rather than approximating.`,
    ),
    body: async () =>
      readout(`All ${PORTS.length}`, rows, {
        what: `A port has exactly one active implementation and answers “who does this job”. Replacing one cannot change an invariant: cache keys are still derived from effects, render is still read-only, the envelope still has two phases. Any that are declared and not implemented are not stubs — calling them throws a named error.`,
        from: 'PORTS and unimplemented() in @weft/kernel; every row describes the port answering this request',
        caveat:
          'A port being implemented says nothing about how good the implementation is. The store here is an isolate-local map with a byte ceiling, and it says so in its own coherence field.',
        tryThis:
          'Read the store row. `coherence: generation` is a process-local tier admitting it cannot be told that something it holds is now wrong.',
      }),
  }
}
