import { createSegmentMemo, render, renderIncremental, TEMPLATE_IR_VERSION, type Values } from '@weft/ir'
import {
  createEnvelope,
  criticalPath,
  type DagNode,
  deferredExecutor,
  degrade,
  type ExceedPolicy,
  fillerSize,
  inlineExecutor,
  isHardLimit,
  leaseCoalescer,
  lifecycle,
  linkHeader,
  schedule,
  serverCapabilities,
} from '@weft/kernel'
import { memoryStore, workerPool } from '@weft/adapters'
import { encodeStream, frame, negotiate, residentFrame, warpFrame } from '@weft/warp'
import { feedItems } from '../data.ts'
import { escapeHtml, field, panel, pick, pre, press, readout, slider } from '../pages.ts'
import { numeric, type StationHandler } from './kind.ts'
import { fragmentIR, listHole } from 'weft'

const n = (v: number): string => v.toLocaleString('en-US')
const utf8 = new TextEncoder()

/**
 * The behaviour stations: things that only mean something when they run. Each one executes the real
 * mechanism on this request rather than describing it, which is why several of them are slow on
 * purpose — a budget you cannot breach and a stampede you cannot cause are not demonstrations.
 */

// ── waves ────────────────────────────────────────────────────────────────────────────

const DAG: DagNode[] = [
  { name: 'session', ms: 4 },
  { name: 'nav', ms: 6 },
  { name: 'cartLines', needs: ['session'], ms: 22 },
  { name: 'prices', needs: ['cartLines'], ms: 14.7 },
  { name: 'recs', needs: ['session'], ms: 31, optional: true },
  { name: 'banner', ms: 9 },
  { name: 'footer', ms: 3 },
  { name: 'reviews', needs: ['cartLines'], ms: 12 },
  { name: 'shipping', needs: ['session'], ms: 8 },
]

export const waves: StationHandler = async (ctx) => {
  const extra = ctx.query('link')
  const nodes: DagNode[] = extra
    ? DAG.map((node) => (node.name === 'recs' ? { ...node, needs: [...(node.needs ?? []), extra] } : node))
    : DAG
  let plan: ReturnType<typeof schedule> | null = null
  let error = ''
  try {
    plan = schedule(nodes)
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  const path = plan ? criticalPath(nodes) : null

  return {
    panel: panel(
      [
        field(
          'give recs another needs edge',
          pick('wave-link', ['', 'nav', 'banner', 'prices', 'nowhere'], extra ?? ''),
        ),
        press('wave-go', 'reschedule'),
      ].join(''),
      'Data dependency only. Existence dependency is not declared and does not block — that is what lets two fragments run at once.',
    ),
    body: async () =>
      error
        ? `<div class="card"><h3>Refused</h3><p class="mono">${escapeHtml(error)}</p><p class="hint">A needs edge to a slot that is not in the plan is a build error rather than a silently dropped dependency.</p></div>`
        : readout(
            'Nine slots, scheduled',
            [
              {
                label: 'waves',
                value: String(plan?.waves.length ?? 0),
                note: plan?.waves.map((w, i) => `${i + 1}: ${w.join(' ')}`).join('   ·   ') ?? '',
              },
              {
                label: 'widest wave',
                value: String(plan?.width ?? 0),
                note: 'compared against the scheduler’s concurrency ceiling — forty parallel queries will melt a database',
              },
              {
                label: 'critical path',
                value: `${path?.ms.toFixed(1)} ms`,
                note: path?.path.join(' → ') ?? '',
                state: 'within',
              },
              {
                label: 'sequential walk',
                value: `${path?.sequentialMs.toFixed(1)} ms`,
                note: 'what a root-to-leaf walk would have cost, for contrast',
                state: 'over',
              },
            ],
            {
              what: `A render DAG, its waves, and its critical path. The waves are what can run at once; the critical path is the only thing that decides how long the page takes. Adding a dependency moves the critical path and leaves the sequential figure exactly where it was, which is the difference between the two numbers.`,
              from: 'schedule() and criticalPath() in @weft/kernel, over the design’s own worked example',
              caveat:
                'The costs here are declared, not measured. `weft why` labels an unmeasured timing as unmeasured for exactly this reason.',
              tryThis:
                'Give recs an edge to `prices`, which is already the deepest chain. Then try `nowhere`, which is not in the plan at all.',
            },
          ),
  }
}

// ── budgets ──────────────────────────────────────────────────────────────────────────

export const budgets: StationHandler = async (ctx) => {
  const budget = numeric(ctx, 'budget', 40, 5, 400)
  const cost = numeric(ctx, 'cost', 120, 0, 2000)
  const policy = (ctx.query('exceed') ?? 'placeholder') as ExceedPolicy

  const job = {
    slot: 'reviews',
    cpuBudgetMs: budget,
    run: async () => {
      await new Promise((resolve) => setTimeout(resolve, cost))
      return utf8.encode('<p>reviews</p>')
    },
  }
  const outcome = await inlineExecutor().run(job)
  const deferred = await deferredExecutor().run(job)

  let degraded = ''
  let threw = ''
  if (outcome.failure) {
    try {
      degraded =
        new TextDecoder().decode(
          degrade(
            { slot: 'reviews', policy, placeholder: utf8.encode('<p class="skeleton"></p>') },
            outcome.failure,
          ),
        ) || '(nothing — an empty region, which is honest)'
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e)
    }
  }

  return {
    panel: panel(
      [
        field('budget (ms)', slider('budget-ms', 5, 400, budget, 5)),
        field('the slot costs (ms)', slider('budget-cost', 0, 2000, cost, 20)),
        field(
          'on exceed',
          pick('budget-exceed', ['placeholder', 'stale', 'fallback', 'client', 'fail'], policy),
        ),
        press('budget-go', 'run it'),
      ].join(''),
      'Make the cost exceed the budget. The same breach produces five different pages depending on the policy.',
    ),
    body: async () =>
      readout(
        'One slot, two executors, one budget',
        [
          {
            label: 'inline',
            value: outcome.failure ? outcome.failure.code : 'within budget',
            note: outcome.failure?.message ?? `${outcome.ms.toFixed(1)} ms`,
            state: outcome.failure ? 'over' : 'within',
          },
          {
            label: 'deferred',
            value: deferred.failure ? deferred.failure.code : 'within budget',
            note: deferred.failure?.message ?? `${deferred.ms.toFixed(1)} ms`,
            state: deferred.failure ? 'over' : 'within',
          },
          {
            label: `on exceed: ${policy}`,
            value: threw ? 'threw' : degraded ? 'degraded' : 'not reached',
            note:
              threw ||
              (degraded ? escapeHtml(degraded) : 'the slot was inside its budget, so nothing degraded'),
            state: threw ? 'over' : 'plain',
          },
          {
            label: 'hard limit?',
            value: 'no',
            note: 'neither of these executors is a separate crash domain, so the render finished either way. The worker-pool station is the one that can stop it',
            state: 'over',
          },
        ],
        {
          what: `A slot given a CPU budget it cannot keep. Both executors report the breach — a budget's job is also to tell you the damage happened — and both messages say whether the work was actually stopped, because a message that does not say is a message that reads like a limit was enforced.`,
          from: 'inlineExecutor(), deferredExecutor() and degrade() in @weft/kernel',
          caveat:
            'This slot sleeps rather than spinning, so `deferred` could in principle abort it at the await. The worker-pool station uses a synchronous loop, which is the case neither of these can touch.',
          tryThis:
            'Set on-exceed to `fail`. That is the one policy that turns a slot breach into a request failure.',
        },
      ),
  }
}

// ── the worker pool ──────────────────────────────────────────────────────────────────

export const workerPoolStation: StationHandler = async (ctx) => {
  const spin = numeric(ctx, 'spin', 400, 0, 3000)
  const budget = numeric(ctx, 'budget', 120, 20, 1000)
  const where = ctx.query('where') ?? 'pool'

  const address = {
    module: new URL('../../../packages/adapters/fixtures/renderers.ts', import.meta.url).pathname,
    export: 'spin',
    props: { ms: spin },
  }

  let label = ''
  let code = ''
  let message = ''
  let ms = 0
  let replaced = 0

  if (where === 'pool') {
    const pool = workerPool({ size: 1 })
    try {
      const outcome = await pool.run({
        slot: 'spinner',
        cpuBudgetMs: budget,
        address,
        run: async () => utf8.encode(''),
      })
      label = `pool · preemption ${pool.preemption}`
      code = outcome.failure?.code ?? 'within budget'
      message = outcome.failure?.message ?? `${outcome.ms.toFixed(0)} ms`
      ms = outcome.ms
      replaced = pool.replaced
    } finally {
      await pool.close()
    }
  } else {
    const executor = where === 'deferred' ? deferredExecutor() : inlineExecutor()
    const outcome = await executor.run({
      slot: 'spinner',
      cpuBudgetMs: budget,
      run: async () => {
        const until = Date.now() + spin
        // A tight synchronous loop: no await to abort at, which is the whole point.
        while (Date.now() < until) {
          /* spin */
        }
        return utf8.encode('done')
      },
    })
    label = `${executor.name} · preemption ${executor.preemption}`
    code = outcome.failure?.code ?? 'within budget'
    message = outcome.failure?.message ?? `${outcome.ms.toFixed(0)} ms`
    ms = outcome.ms
  }

  return {
    panel: panel(
      [
        field('synchronous loop (ms)', slider('pool-spin', 0, 3000, spin, 100)),
        field('cpu budget (ms)', slider('pool-budget', 20, 1000, budget, 20)),
        field('run it on', pick('pool-where', ['pool', 'inline', 'deferred'], where)),
        press('pool-go', 'run it'),
      ].join(''),
      'The render is a tight synchronous loop. There is no await in it, so there is nothing for a cooperative signal to abort at.',
    ),
    body: async () =>
      readout(
        'A loop that does not cooperate',
        [
          {
            label: 'executor',
            value: label,
            note: 'the executor’s own declaration of how far it can be interrupted',
          },
          { label: 'outcome', value: code, note: message, state: code === 'E_CPU_BUDGET' ? 'over' : 'plain' },
          {
            label: 'wall clock',
            value: `${ms.toFixed(0)} ms`,
            note:
              where === 'pool'
                ? 'stopped at the budget, not at the end of the loop'
                : 'the loop ran to completion regardless of the budget',
            state: where === 'pool' && ms < spin ? 'within' : 'over',
          },
          {
            label: 'workers replaced',
            value: String(replaced),
            note: 'killing a render costs the worker, so the pool replaces it and counts it. A breach is not free',
          },
          {
            label: 'hard limit?',
            value: where === 'pool' ? 'yes' : 'no',
            note: isHardLimit(where === 'pool' ? 'always' : 'never')
              ? 'a thread can be stopped mid-instruction'
              : 'same thread: a budget here is a report',
            state: where === 'pool' ? 'within' : 'over',
          },
        ],
        {
          what: `The difference between a budget that reports and a budget that stops the work. Set the loop above the budget and switch executors: on the pool the wall clock stops at the budget, and on the request thread it stops when the loop finishes. That is the only reason to pay for a thread.`,
          from: 'workerPool() in @weft/adapters and the executors in @weft/kernel, running renderers.ts by name',
          caveat:
            'A pooled render has to be reachable by name — `ExecutorPort.run` takes a closure and a closure cannot cross a crash domain. A slot naming a pool with no address is a build error, not a request-time surprise.',
          tryThis:
            'Set the loop to 3000 ms and the budget to 100 on the pool. Then switch to inline and watch the wall clock.',
        },
      ),
  }
}

// ── incremental recompute ────────────────────────────────────────────────────────────

export const incremental: StationHandler = async (ctx) => {
  const rows = numeric(ctx, 'rows', 200, 10, 800)
  const changeEvery = numeric(ctx, 'every', 8, 2, 50)
  const reorder = ctx.query('reorder') === 'yes'
  const feed = fragmentIR('fragment:clock')
  const binding = listHole(feed)
  const memo = createSegmentMemo()

  const before = {
    heading: 'Markets',
    count: rows,
    generated: 0,
    [binding]: feedItems(rows, 0, changeEvery),
  } as unknown as Values
  const cold = renderIncremental({ ir: feed.entry, values: before, memo, resolve: feed.resolve })

  const nextItems = feedItems(rows, 1, changeEvery)
  const after = {
    heading: 'Markets',
    count: rows,
    generated: 1,
    [binding]: reorder ? nextItems.toReversed() : nextItems,
  } as unknown as Values
  const warm = renderIncremental({
    ir: feed.entry,
    values: after,
    memo,
    resolve: feed.resolve,
    previous: { resolved: cold.resolved, supplied: before },
  })
  const full = render(feed.entry, after, feed.resolve)
  const identical = full.length === warm.bytes.length && full.every((b, i) => b === warm.bytes[i])

  return {
    panel: panel(
      [
        field('rows', slider('inc-rows', 10, 800, rows, 10)),
        field('one row in every', slider('inc-every', 2, 50, changeEvery, 1)),
        field('reorder', pick('inc-reorder', ['no', 'yes'], reorder ? 'yes' : 'no')),
        press('inc-go', 'render twice'),
      ].join(''),
      'The first render fills the memo; the second one is the interesting number.',
    ),
    body: async () =>
      readout(
        `${n(rows)} rows, one in every ${changeEvery} changed`,
        [
          {
            label: 'cold: rows rendered',
            value: n(cold.stats.segments.rendered),
            note: 'an empty memo, so every row is new',
          },
          {
            label: 'warm: rows reused',
            value: n(warm.stats.segments.reused),
            note: 'served from the memo, content-addressed, so identical content is identical bytes',
            state: 'within',
          },
          {
            label: 'warm: rows rendered',
            value: n(warm.stats.segments.rendered),
            note: reorder
              ? 'a reorder changes no content, so a content-addressed memo reuses everything'
              : 'exactly the rows whose content changed',
            state: 'within',
          },
          {
            label: 'derived recomputed / reused',
            value: `${warm.stats.derived.recomputed} / ${warm.stats.derived.reused}`,
            note: 'a derived value a change cannot reach is carried over rather than re-evaluated',
          },
          {
            label: 'structural changes',
            value: warm.stats.structural.length ? warm.stats.structural.join(', ') : 'none',
            note: 'a hole whose shape changed rather than whose value did. Nothing can be reused for one',
          },
          {
            label: 'byte-identical to a full render',
            value: identical ? 'yes' : 'NO',
            note: 'the property that makes this safe to turn on, checked here on this request',
            state: identical ? 'within' : 'over',
          },
        ],
        {
          what: `A rendered nested template is a pure function of its version and its values, so it is content-addressed and reusable. A long list where a few rows changed costs a few row renders. A *reordered* list costs none, because the key is the content and not the index.`,
          from: 'renderIncremental() and createSegmentMemo() in @weft/ir, over the real feed fragment',
          caveat:
            'Only nested templates are memoised. A text hole is one escape scan and one encode, and hashing its value would cost more than rendering it. The memo is also process-local, because render() is synchronous and a shared tier could not answer it.',
          tryThis: 'Turn reorder on. Every row is reused, which an index-keyed memo could not do.',
        },
      ),
  }
}

// ── negotiation ──────────────────────────────────────────────────────────────────────

export const negotiation: StationHandler = async (ctx) => {
  const clientIr = ctx.query('ir') ?? TEMPLATE_IR_VERSION
  const clientWarp = ctx.query('warp') ?? '1.2.0'
  const transport = (ctx.query('transport') ?? 'stream') as 'stream' | 'buffered' | 'socket'
  const dsd = ctx.query('dsd') !== 'no'

  const settled = negotiate(
    {
      warp: clientWarp,
      ir: clientIr,
      forms: ['html', 'bundle', 'split', 'patch', 'delta'],
      transport,
      dsd,
      vt: true,
      sw: false,
      idb: true,
    },
    serverCapabilities(),
  )

  return {
    panel: panel(
      [
        field('client IR', pick('neg-ir', [TEMPLATE_IR_VERSION, '2.0.0', '1.9.0', '3.0.0'], clientIr)),
        field('client Warp', pick('neg-warp', ['1.2.0', '1.0.0', '2.0.0'], clientWarp)),
        field('transport', pick('neg-transport', ['stream', 'buffered', 'socket'], transport)),
        field('incremental DSD', pick('neg-dsd', ['yes', 'no'], dsd ? 'yes' : 'no')),
        press('neg-go', 'negotiate'),
      ].join(''),
      'Nothing here fails. Every missing capability costs a form, a fill mechanism or an animation — never correctness.',
    ),
    body: async () =>
      readout(
        'What this client gets',
        [
          {
            label: 'ok',
            value: settled.ok ? 'yes' : 'no',
            note: settled.fatal ?? 'the channel is available',
            state: settled.ok ? 'within' : 'over',
          },
          {
            label: 'forms',
            value: settled.forms.join(', '),
            note: 'html is always there: it is the floor that needs nothing resident',
          },
          {
            label: 'strategy',
            value: settled.strategy,
            note: 'stream, collapse (a buffered webview), or socket',
          },
          {
            label: 'fill',
            value: settled.fill,
            note: `who fills an out-of-order hole — the parser, or the ${fillerSize()}-byte filler script`,
          },
          {
            label: 'commit',
            value: settled.commit,
            note: 'an epoch commit is animated only where View Transitions exist',
          },
          {
            label: 'residency',
            value: settled.residency,
            note: 'where a returning client may keep resident templates',
          },
          {
            label: 'resumable',
            value: settled.resumable ? 'yes' : 'no',
            note: 'whether a severed channel may continue instead of restarting',
          },
          {
            label: 'downgrades',
            value: String(settled.downgrades.length),
            note: settled.downgrades.join(' · ') || 'none',
            state: settled.downgrades.length ? 'plain' : 'within',
          },
        ],
        {
          what: `Capability variance is not a special case here: a browser, a webview and a stale cache are the same problem and get the same mechanism. Every downgrade is named and visible rather than being a silent fallback.`,
          from: 'negotiate() in @weft/warp against serverCapabilities() in @weft/kernel',
          caveat:
            'The server side of this composition is the one place that can see both the Warp version and the IR version. A default in either package alone was wrong for months — see spec/FINDINGS.md.',
          tryThis:
            'Set the client IR to 1.9.0 — a different major — and watch every form except html disappear. Then set Warp to 2.0.0, which is fatal to the channel and not to the page.',
        },
      ),
  }
}

// ── warp frames ──────────────────────────────────────────────────────────────────────

export const warp: StationHandler = async (ctx) => {
  const cold = ctx.query('visit') !== 'warm'
  const settled = negotiate(
    { warp: '1.2.0', ir: TEMPLATE_IR_VERSION, forms: ['html', 'delta'], transport: 'stream' },
    serverCapabilities(),
  )
  const frames = [
    warpFrame(settled),
    frame('SHELL', { route: '/app/feed', tpl: fragmentIR('fragment:clock').entry.version }),
    ...(cold
      ? fragmentIR('fragment:clock').templates.map((t) =>
          frame(
            'TPL',
            { tpl: t.version },
            utf8.encode(JSON.stringify({ version: t.version, holes: t.holes.length })),
            true,
          ),
        )
      : []),
  ]
  const bytes = encodeStream(frames)
  const hello = residentFrame({ warp: '1.2.0', ir: TEMPLATE_IR_VERSION, forms: ['html', 'delta'] })

  const listing = frames
    .map(
      (f) =>
        `${f.kind.padEnd(8)} ${Object.entries(f.header)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ')}`,
    )
    .join('\n')

  return {
    panel: panel(
      [
        field('visit', pick('warp-visit', ['cold', 'warm'], cold ? 'cold' : 'warm')),
        press('warp-go', 'encode'),
      ].join(''),
      'On a warm visit the server sends no TPL frames at all, because the client already holds the templates.',
    ),
    body: async () =>
      readout(
        `${cold ? 'A cold visit' : 'A warm visit'}: ${frames.length} frames, ${n(bytes.length)} bytes`,
        [
          { label: 'preamble', value: '8 B', note: 'magic, then the major and minor the sender is speaking' },
          { label: 'frames', value: String(frames.length), note: frames.map((f) => f.kind).join(' → ') },
          {
            label: 'total',
            value: `${n(bytes.length)} B`,
            note: 'length-prefixed, so a reader that does not know a code skips it',
            state: cold ? 'plain' : 'within',
          },
          {
            label: 'what the client said first',
            value: 'RESIDENT',
            note: Object.entries(hello.header)
              .map(([k, v]) => `${k}=${v}`)
              .join(' '),
          },
        ],
        {
          what: `The frames a document arrives with. WARP states the versions and the strategy the server settled on; SHELL names the entry template; TPL carries a template the client does not hold. A warm visit skips every TPL, which is the entire repeat-visit claim.`,
          from: 'warpFrame(), encodeStream() and residentFrame() in @weft/warp, over the real feed templates',
          caveat:
            'This is the frame vocabulary, not a live channel. The channel station is the one where these travel over a socket.',
          tryThis:
            'Switch to a warm visit and watch the byte count fall to the two frames that always have to be there.',
        },
      ),
    readout: pre(listing),
  }
}

// ── escaping ─────────────────────────────────────────────────────────────────────────

export const escaping: StationHandler = async (ctx) => {
  const value = ctx.query('value') ?? '<img src=x onerror=alert(1)> & "quoted"'
  const article = fragmentIR('fragment:static')
  const blocks = listHole(article)
  const html = new TextDecoder().decode(
    render(
      article.entry,
      {
        title: value,
        standfirst: value,
        byline: 'byline',
        [blocks]: [{ kind: 'p', text: value }],
      } as unknown as Values,
      article.resolve,
    ),
  )
  const rawHtml = new TextDecoder().decode(
    render(
      fragmentIR('fragment:markup').entry,
      { html: value } as unknown as Values,
      fragmentIR('fragment:markup').resolve,
    ),
  )
  const holes = article.entry.holes.map((h) => `${h.binding}: ${h.escape}`)

  return {
    panel: panel(
      [
        field('value', `<input id="esc-value" size="42" value="${escapeHtml(value)}">`),
        press('esc-go', 'render'),
      ].join(''),
      'The same string through an escaped hole and through the one trusted-raw hole in this demo.',
    ),
    body: async () =>
      readout(
        'One value, two escape classes',
        [
          { label: 'hole classes', value: String(article.entry.holes.length), note: holes.join(' · ') },
          {
            label: 'through article.tsx',
            value: 'escaped',
            note: 'the compiler could not prove the value safe, so it escapes',
            state: 'within',
          },
          {
            label: 'through markup.tsx',
            value: 'trusted-raw',
            note: 'raw() — the compiler records the provenance and escapes nothing',
            state: 'over',
          },
        ],
        {
          what:
            `The escape class of every hole comes from the syntax around it, decided at compile time. A value the compiler cannot prove safe is escaped; ` +
            `a value passed through raw() is not, and the compiler records where that decision was made. The two panes below are the same string rendered both ways.`,
          from: 'render() in @weft/ir over the real article.tsx and markup.tsx holes',
          caveat:
            'Escape elision is kept for correctness and for native codec boundaries. It is measured at no throughput gain, and the repo says so.',
          tryThis:
            'Paste a script tag. Through the escaped hole it is text; through the raw hole it is markup, which is exactly why there is only one raw hole in this demo.',
        },
      ),
    readout: `<div class="card"><h3>Escaped</h3>${pre(html)}<h3>trusted-raw</h3>${pre(rawHtml)}</div>`,
  }
}

// ── the envelope ─────────────────────────────────────────────────────────────────────

export const envelope: StationHandler = async () => {
  const life = lifecycle()
  const env = createEnvelope(life)
  life.to('envelope')
  env.setCookie({ name: 'sid', value: 'demo', httpOnly: true, path: '/' })
  env.header('x-demo', 'phase-a')
  const sealed = env.seal()

  let afterSeal = ''
  try {
    env.header('x-too-late', '1')
  } catch (e) {
    afterSeal = e instanceof Error ? e.message : String(e)
  }

  let nonIdempotent = ''
  try {
    env.deferrable({ kind: 'cookie', cookie: { name: 'consent', value: 'yes' }, reason: 'recording consent' })
  } catch (e) {
    nonIdempotent = e instanceof Error ? e.message : String(e)
  }

  return {
    panel: panel(
      '',
      'Phase A and phase B are two different context types, not one with a flag on it — so the mistake cannot be written.',
    ),
    body: async () =>
      readout(
        'What the envelope allows, and when',
        [
          {
            label: 'phase A writes',
            value: 'accepted',
            note: `status ${sealed.status ?? 200} · a real HttpOnly Set-Cookie · a header`,
            state: 'within',
          },
          {
            label: 'lifecycle',
            value: life.log.join(' → '),
            note: 'declared transitions; anything else is E_REQUEST_STATE',
          },
          {
            label: 'after the seal',
            value: afterSeal ? 'refused' : 'ALLOWED',
            note: afterSeal || 'this should not happen',
            state: afterSeal ? 'within' : 'over',
          },
          {
            label: 'a non-idempotent deferral',
            value: nonIdempotent ? 'refused' : 'ALLOWED',
            note: nonIdempotent || 'this should not happen',
            state: nonIdempotent ? 'within' : 'over',
          },
          {
            label: 'phase B context',
            value: 'no envelope methods at all',
            note: 'RenderContext has no setCookie, no status, no redirect. Not a runtime check — there is nothing to call',
            state: 'within',
          },
        ],
        {
          what: `What is irreducibly lost after the first body byte: a real status code, an HttpOnly cookie, Cache-Control, Vary, and a redirect a crawler will follow. Rather than document that, the lifecycle splits — phase A owns the envelope and phase B gets a context type with none of it on it.`,
          from: 'createEnvelope() and lifecycle() in @weft/kernel, run on this request',
          caveat:
            'A deferred effect waits for the next request on the connection, and is dropped if there is no next request. That is why only idempotent effects qualify, and why `deferrable` refuses anything that reads as consent, payment or a nonce by name.',
          tryThis:
            'Open /app/cart with no session cookie. The guard redirects in phase A, which is a real 302 rather than a body that asks the client to navigate.',
        },
      ),
  }
}

// ── early hints ──────────────────────────────────────────────────────────────────────

export const earlyHints: StationHandler = async () => {
  const links = [
    { href: '/demo.css', as: 'style' as const, rel: 'preload' as const },
    { href: '/demo/boot.ts', as: 'script' as const, rel: 'modulepreload' as const },
    { href: '/runtime/adopt.ts', as: 'script' as const, rel: 'modulepreload' as const },
  ]
  return {
    panel: panel(
      '',
      'This page was served over HTTP/1.1 on loopback, where a 103 is legal to send and a client is entitled to ignore it.',
    ),
    body: async () =>
      readout(
        'The critical set, and whether it went out',
        [
          {
            label: 'links',
            value: String(links.length),
            note: links.map((l) => `${l.rel} ${l.href}`).join(' · '),
          },
          {
            label: 'Link header',
            value: `${linkHeader(links).length} B`,
            note: escapeHtml(linkHeader(links)),
          },
          {
            label: 'did the 103 go out?',
            value: 'reported, never assumed',
            note: 'sendEarlyHints() returns a boolean because 103 is H2/H3 only. A framework that returned void here would be making a claim it cannot check',
            state: 'plain',
          },
          {
            label: 'why it matters',
            value: 'discovery is not downstream of the query',
            note: 'the links go out at effectively zero milliseconds and the envelope stays open, so a slow slot does not delay asset discovery',
            state: 'within',
          },
        ],
        {
          what: `103 Early Hints decouples asset discovery from committing to a response. The links can go out before the server knows the status, and the envelope stays open — which removes the most common reason to want a late header.`,
          from: 'linkHeader() in @weft/kernel; the transport port is nodeTransport, which is writing this response',
          caveat:
            'nodeTransport reports whether writeEarlyHints actually ran. On HTTP/1.1 a client simply waits for the final response, so a “sent” here is not a “used”. The one bug this found is in spec/FINDINGS.md: Node rejects a comma-joined Link value and wants an array, which only a two-link page reveals.',
          tryThis:
            'Open the dashboard, where the slowest panel takes 600 ms. The stylesheet is discovered long before it lands.',
        },
      ),
  }
}

// ── stampede ─────────────────────────────────────────────────────────────────────────

export const stampede: StationHandler = async (ctx) => {
  const concurrency = numeric(ctx, 'clients', 12, 2, 200)
  const cost = numeric(ctx, 'cost', 60, 0, 500)
  const guarded = ctx.query('lease') !== 'no'

  const store = memoryStore()
  const coalesce = leaseCoalescer(store, { pollMs: 2 })
  let renders = 0
  const render_ = async (): Promise<Uint8Array> => {
    renders++
    await new Promise((resolve) => setTimeout(resolve, cost))
    const bytes = utf8.encode('<p>rendered</p>')
    await store.set('hot', bytes, { class: 'shared' })
    return bytes
  }

  const started = Date.now()
  if (guarded) {
    await Promise.all(Array.from({ length: concurrency }, () => coalesce('hot', render_)))
  } else {
    await Promise.all(Array.from({ length: concurrency }, () => render_()))
  }
  const ms = Date.now() - started

  return {
    panel: panel(
      [
        field('concurrent misses', slider('stamp-clients', 2, 200, concurrency, 2)),
        field('render cost (ms)', slider('stamp-cost', 0, 500, cost, 10)),
        field('take the lease', pick('stamp-lease', ['yes', 'no'], guarded ? 'yes' : 'no')),
        press('stamp-go', 'stampede'),
      ].join(''),
      'A miss under load is where a cache stops helping. Turn the lease off and watch the render count follow the client count.',
    ),
    body: async () =>
      readout(
        `${concurrency} concurrent misses on one key`,
        [
          {
            label: 'renders',
            value: n(renders),
            note: guarded
              ? 'one renderer took the lease; the rest waited for its result'
              : 'every caller rendered, which is what a cache is supposed to prevent',
            state: guarded ? 'within' : 'over',
          },
          {
            label: 'wall clock',
            value: `${ms} ms`,
            note: 'the waiters poll, so they pay a poll interval rather than a render',
          },
          {
            label: 'wasted renders',
            value: n(renders - 1),
            note: 'each one is the expensive part of the request, done for nothing',
            state: renders > 1 ? 'over' : 'within',
          },
        ],
        {
          what: `N requests miss the same cacheable key at once. Without a lease they all render, which turns a cold cache into an incident. With one, a single renderer fills the key and the rest are handed its result.`,
          from: 'leaseCoalescer() in @weft/kernel over a real memoryStore, run on this request',
          caveat:
            'The wait is bounded: on expiry a waiter renders anyway, because a duplicated render is worse than a hit and much better than a request hanging behind a renderer that died. This polls, because an isolate-local map cannot announce a fill — a store with pub/sub should subscribe, and the kernel deliberately has no opinion about which.',
          tryThis:
            'Turn the lease off with 200 clients and a 500 ms render. That is the shape of a real incident.',
        },
      ),
  }
}
