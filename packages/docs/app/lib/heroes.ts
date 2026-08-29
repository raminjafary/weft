import { criticalPath, schedule } from '@weftjs/kernel'
import { escapeHtml } from './escape.ts'
import { caption } from './openers.ts'
import { siteWeight } from './budgets.ts'
import { raceFigure, stagedClick } from './measured.ts'
import { graph, type GraphEdge, type GraphNode } from './graph.ts'

/**
 * The figure at the top of each guide page: the mechanism, moving. Twenty-two pages share one
 * vocabulary — a row arriving in turn, a box, a pill, a scaled bar, a travelling mark, a label
 * swap — moving only where movement *is* the idea. Every animated element carries `data-wf` and
 * every keyframe ends at the meaningful state, so reduced-motion is the finished diagram.
 */

const enc = escapeHtml

/** One cycle. Long enough to read a six-row sequence without hurrying it. */
const CYCLE = 4.6

/* ── the kit ──────────────────────────────────────────────────────────────── */

/** A row that arrives when its turn comes. Base opacity is 16%, not 0, so a mid-cycle arrival still reads as a diagram filling in, not content appearing from nowhere. */
function step(at: number, body: string, extra = ''): string {
  return `<div data-wf class="hs"${extra} style="animation:wf-step ${CYCLE}s linear ${at.toFixed(
    2,
  )}s infinite">${body}</div>`
}

type Tone = 'plain' | 'lit' | 'no' | 'ghost'

function tone(which: Tone): string {
  return which === 'plain' ? '' : ` ${which}`
}

/** A line of code at figure scale. Most of these figures are made of these. */
function code(text: string, which: Tone = 'plain'): string {
  return `<span class="hc${tone(which)}">${enc(text)}</span>`
}

/** A small labelled block: a slot, a port, a frame code, a verdict. */
function pill(text: string, which: Tone = 'plain'): string {
  return `<span class="hp${tone(which)}">${enc(text)}</span>`
}

/** A bordered panel holding one line — a file, a stage, a node in the DOM. */
function box(body: string, kind: '' | 'lit' | 'dashed' | 'tight' = ''): string {
  return `<div class="hbox${kind ? ` ${kind}` : ''}">${body}</div>`
}

const ARROW = '<span class="harrow">&#8594;</span>'

/** A leader line, so a name on the left and a number on the right belong to each other. */
const LEAD = '<span class="hlead"></span>'

/** Rows in a column. `tight` is the terminal spacing; the default is the diagram spacing. */
function rows(items: readonly string[], tight = false): string {
  return `<div class="hrows${tight ? ' tight' : ''}">${items.join('')}</div>`
}

/** One row across: a label, whatever it is about, and often a number at the end. */
function row(body: string): string {
  return `<div class="hrow">${body}</div>`
}

/** An edge with one mark travelling it — every hand-off in these figures is drawn this way. */
function wire(at = 0): string {
  return `<div class="hwire"><span data-wf class="hdot" style="animation:wf-travel ${CYCLE}s linear ${at.toFixed(
    2,
  )}s infinite"></span></div>`
}

/** One label in the place of another. Both sit in the same grid cell so the row doesn't resize when they trade places. */
function swap(before: string, after: string): string {
  return `<span class="hswap">
    <span data-wf class="hswap-a" style="animation:wf-swap-a ${CYCLE}s linear infinite">${before}</span>
    <span data-wf class="hswap-b" style="animation:wf-swap-b ${CYCLE}s linear infinite">${after}</span>
  </span>`
}

/** A bar drawn to scale inside a row. */
function bar(share: number, which: Tone, at: number): string {
  return `<span class="hb-track"><span data-wf class="hb-fill${tone(which)}" style="width:${(
    share * 100
  ).toFixed(1)}%;animation:wf-grow ${CYCLE}s cubic-bezier(.2,.7,.3,1) ${at.toFixed(
    2,
  )}s infinite"></span></span>`
}

/** A bar row: what it is, how long it took, and the number. */
function meter(label: string, share: number, value: string, which: Tone, at: number): string {
  return row(`${code(label)}${bar(share, which, at)}${code(value)}`)
}

/** A note in the figure's own voice — smaller, and not code. */
function note(text: string, wide = false): string {
  return `<span class="hnote${wide ? ' wide' : ''}">${enc(text)}</span>`
}

/** The frame every hero sits in: the drawing, and the sentence saying what it showed. */
function frame(slug: string, body: string): string {
  const says = caption(slug)
  return `<figure class="hero-fig">
    <div class="hero-fig-in">${body}</div>
    ${says ? `<figcaption>${enc(says)}</figcaption>` : ''}
  </figure>`
}

/* ── the figures ──────────────────────────────────────────────────────────── */

/** Every file the command writes, in the order you would read the folder. */
function gettingStarted(): string {
  const tree: readonly [number, string, string][] = [
    [0, 'my-app/', '21 files'],
    [1, 'app/', ''],
    [2, 'layout.tsx', 'the document. Its slot holes are what a route fills'],
    [2, 'layout.css', 'linked by every page under it'],
    [2, 'styles.css', 'the application’s own sheet'],
    [2, 'routes/', 'the route table — this subtree is it'],
    [3, 'index.tsx', '/'],
    [3, 'index.data.ts', 'head, cache policy, loader'],
    [3, 'index.css', 'linked only by the pages that render index'],
    [2, 'fragments/', ''],
    [1, 'weft.config.ts', 'every line commented out — an application with no config still has a store'],
  ]
  return frame(
    'getting-started',
    `<div class="hcmd">
       <span class="hc dim">$</span><span class="hc lit">npm create weft my-app</span>
       <span data-wf class="caret" style="animation:wf-caret 1.1s steps(1) infinite"></span>
       <span class="hcmd-end">${pill('--template app', 'lit')}${pill('--template minimal')}</span>
     </div>
     <div class="hpanel">
       <div class="hpanel-head">
         <span class="hpanel-kicker">template app — the default</span>
         <span class="hnote">a working page, a param route, one mutation</span>
       </div>
       ${tree
         .map(([depth, name, says], at) =>
           step(
             at * 0.2,
             `<div class="htree" style="padding-inline-start:${depth * 16}px">
                <span class="hc${depth >= 2 ? ' lit' : ' dim'}">${enc(name)}</span>
                ${says ? `<span class="hnote end">${enc(says)}</span>` : ''}
              </div>`,
           ),
         )
         .join('')}
     </div>`,
  )
}

/** The route table is the file tree, drawn as the walk that produces it. */
function anApplication(): string {
  const files: readonly [string, string][] = [
    ['index.tsx', '/'],
    ['[slug].tsx', '/:slug'],
    ['docs/[...].tsx', '/docs/*'],
  ]
  const nodes: GraphNode[] = [
    { id: 'dir', x: 4, y: 100, w: 160, h: 41, title: 'app/routes/', at: 0 },
    ...files.map(([file], at) => ({
      id: `f${at}`,
      x: 222,
      y: 6 + at * 62,
      w: 216,
      h: 41,
      title: file,
      at: 0.8 + at * 0.2,
    })),
    { id: 'data', x: 222, y: 192, w: 216, h: 41, title: 'x.data.ts', at: 1.4 },
    ...files.map(([, url], at) => ({
      id: `u${at}`,
      x: 496,
      y: 6 + at * 62,
      w: 240,
      h: 41,
      title: url,
      accent: true,
      at: 2.2 + at * 0.2,
    })),
    { id: 'plan', x: 496, y: 192, w: 240, h: 41, title: 'head · policy · slots', at: 2.8 },
  ]
  const edges: GraphEdge[] = [
    ...files.map((_, at) => ({ from: 'dir', to: `f${at}`, at: 0.4 + at * 0.1, flow: 0.8 + at * 0.1 })),
    { from: 'dir', to: 'data', at: 0.7, flow: 1.1 },
    ...files.map((_, at) => ({ from: `f${at}`, to: `u${at}`, at: 1.8 + at * 0.1, flow: 2.2 + at * 0.1 })),
    { from: 'data', to: 'plan', at: 2.1, flow: 2.5 },
  ]
  return frame('an-application', graph(nodes, edges, { height: 246, cycle: 5.4, baselines: [26, 42, 56] }))
}

/** A template as what it actually is: finished bytes, with gaps. Constant runs never move; only the holes arrive. */
function fragments(): string {
  const strip: readonly (number | 'hole')[] = [2, 'hole', 1.4, 'hole', 1.4, 'hole', 1.4]
  let hole = 0
  const cells = strip
    .map((cell) => {
      if (cell !== 'hole') return `<span class="hseg" style="flex:${cell}"></span>`
      hole += 1
      return step(hole * 0.84 - 0.42, `<span class="hseg hole"></span>`, ' style="flex:.8"')
    })
    .join('')
  return frame(
    'fragments',
    `<div class="hstrip">${cells}</div>
     ${row(
       `${note('pre-encoded bytes')}${note('·')}${note('holes, filled per render')}
        <span class="hpush"></span>
        ${step(2.52, code('version t_9f4c1ab2 — a hash of its content', 'lit'))}`,
     )}`,
  )
}

/** One fragment inside another, and the flat stream both of them lower to. */
function components(): string {
  return frame(
    'components',
    `${step(0, box(`${code('&lt;Card&gt;')}${note('outer template')}`))}
     <div class="hnest">${step(0.42, box(code('children — one hole, any shape'), 'dashed'))}</div>
     ${wire()}
     ${step(1.26, box(code('one stream of segments · nothing nested at runtime', 'lit'), 'lit'))}`,
  )
}

/** The attribute the compiler stamps, and the three places it shows up. */
function scopedStyles(): string {
  const panes: readonly [string, string, Tone][] = [
    [
      'card.scoped.css — as authored',
      '.card { border: 1px solid red }\n.card .body { opacity: 0.7 }',
      'plain',
    ],
    [
      'card.tsx — sealed by the compiler',
      '<div data-w-d901a5ad class="card">\n  <p data-w-d901a5ad class="body">',
      'lit',
    ],
    ['on the wire', '.card[data-w-d901a5ad] { … }\n.card .body[data-w-d901a5ad] { … }', 'lit'],
  ]
  return frame(
    'scoped-styles',
    `<div class="hpanes">${panes
      .map(([head, body, which], at) =>
        step(
          at * 0.6,
          `<div class="hpane">
             <div class="hpane-head">${enc(head)}</div>
             <pre class="hpane-body">${body
               .split('\n')
               .map((each) => `<span class="hc${tone(which)}">${enc(each)}</span>`)
               .join('')}</pre>
           </div>`,
        ),
      )
      .join('')}</div>`,
  )
}

/** Holes fill outside in, so the figure is three bands nested in that order. */
function layouts(): string {
  return frame(
    'layouts',
    step(
      0,
      `<div class="hbox wrap">
         ${code('app/layout.tsx — the document')}
         <div class="hinner">${step(
           0.42,
           `<div class="hbox wrap inner">
              ${code('routes/guide/layout.tsx — contents, body, outline')}
              <div class="hinner">${step(
                0.84,
                box(code('the page — one slot, deep in a chain', 'lit'), 'lit'),
              )}</div>
            </div>`,
         )}</div>
       </div>`,
    ),
  )
}

/** A read, and the three things that follow from it with nothing in between to configure. */
function effectsAndCache(): string {
  return frame(
    'effects-and-cache',
    `${step(
      0,
      box(`${code('const u = ')}${code('ctx.identity()', 'lit')}${code('   // a read, inferred', 'ghost')}`),
    )}
     ${row(
       ['taint: identity', 'class: private', 'key: identity + route:page']
         .map((each, at) => `${at ? ARROW : ''}${step(0.42 + at * 0.42, pill(each, 'lit'))}`)
         .join(''),
     )}`,
  )
}

/** The two delivery orders, raced on one clock — identical DOM, only the arrival timing differs. Each region is a dashed outline filled on landing. */
function slotsAndStreaming(): string {
  const lane = (
    kind: string,
    says: string,
    bands: readonly { label: string; tall?: boolean; anim: string; lit?: boolean }[],
    ticks: readonly { at: number; label: string; anim: string; lit?: boolean }[],
  ): string => `<div class="hlane">
      <div class="hlane-head"><span class="hlane-kind">${enc(kind)}</span>${note(says)}</div>
      <div class="hbands">${bands
        .map(
          (band) => `<div class="hband${band.tall === true ? ' tall' : ''}">
            ${band.tall === true ? `<span class="hband-wait">${enc(band.label)} — 80 ms</span>` : ''}
            <span data-wf class="hband-in${band.lit === true ? ' lit' : ''}" style="animation:${
              band.anim
            } 3.2s linear infinite">${enc(band.label)}</span>
          </div>`,
        )
        .join('')}</div>
      <div class="hclock">
        <span data-wf class="hclock-head" style="animation:wf-play 3.2s linear infinite"></span>
        <span class="hclock-rule"></span>
        ${ticks
          .map(
            (tick) =>
              `<span data-wf class="hclock-tick${tick.lit === true ? ' lit' : ''}${
                tick.at > 50 ? ' late' : ''
              }" style="left:${tick.at}%;animation:${tick.anim} 3.2s linear infinite">${enc(
                tick.label,
              )}</span>`,
          )
          .join('')}
      </div>
    </div>`
  return frame(
    'slots-and-streaming',
    `<div class="hlanes">
      ${lane(
        'In order',
        'the shell waits',
        [
          { label: 'shell', anim: 'wf-shell' },
          { label: 'feed', tall: true, anim: 'wf-slow' },
          { label: 'prices', anim: 'wf-fast-io', lit: true },
        ],
        [{ at: 100, label: raceFigure('chromium', 'in-order'), anim: 'wf-tick-late' }],
      )}
      ${lane(
        'Out of order',
        'whatever is ready goes first',
        [
          { label: 'shell', anim: 'wf-shell' },
          { label: 'prices', anim: 'wf-fast-oo', lit: true },
          { label: 'feed', tall: true, anim: 'wf-slow' },
        ],
        [
          { at: 21, label: raceFigure('chromium', 'out-of-order'), anim: 'wf-tick', lit: true },
          { at: 100, label: raceFigure('chromium', 'in-order'), anim: 'wf-tick-late' },
        ],
      )}
     </div>`,
  )
}

/** The waves the kernel builds, and what they cost against the same work one slot at a time. */
function whereItRuns(): string {
  const slots = [
    { name: 'header', ms: 20 },
    { name: 'nav', ms: 10.9 },
    { name: 'items', ms: 20 },
    { name: 'feed', ms: 22 },
    { name: 'total', needs: ['items'], ms: 9.3 },
    { name: 'prices', needs: ['items'], ms: 8.4 },
    { name: 'related', needs: ['feed'], ms: 14 },
    { name: 'summary', needs: ['total', 'prices'], ms: 12 },
    { name: 'footer', needs: ['related'], ms: 6.7 },
  ]
  const plan = schedule(slots)
  const path = criticalPath(slots)
  return frame(
    'where-it-runs',
    `${rows(
      plan.waves.map((wave, at) =>
        step(at * 0.84, row(`${code(`wave ${at + 1}`, 'lit')}${wave.map((name) => pill(name)).join('')}`)),
      ),
    )}
     <div class="hbars">
       ${meter('sequential', 1, `${path.sequentialMs.toFixed(1)} ms`, 'ghost', 0)}
       ${meter('waves', path.ms / path.sequentialMs, `${path.ms.toFixed(1)} ms`, 'lit', 0.32)}
     </div>`,
  )
}

/** What the build wrote, and what it refused to write, with the reason beside each. */
function declarations(files: number): string {
  return frame(
    'declarations',
    rows(
      [
        step(0, code('$ weft build', 'lit')),
        step(0.42, code(`  ${files} files written to .weft/static/`)),
        step(0.84, code('  /play — not a file: reads what you typed', 'ghost')),
        step(1.26, code('  /play — not a file: reads route:src', 'ghost')),
      ],
      true,
    ),
  )
}

/** A recording, and the one decision it is allowed to change. */
function measuring(): string {
  const seen: readonly [string, number, number][] = [
    ['header', 2, 0.1],
    ['prices', 6, 0.38],
    ['feed', 81, 0.66],
    ['related', 78, 0.94],
  ]
  return frame(
    'measuring',
    `${seen
      .map(([name, ms, share], at) => meter(name, share, `${ms} ms`, ms > 40 ? 'lit' : 'ghost', at * 0.16))
      .join('')}
     <div class="hafter">${row(
       `${note('the next generation plans delivery from it')}
        ${swap(pill('feed: buffer'), pill('feed: stream', 'lit'))}`,
     )}</div>`,
  )
}

/** Adoption records where each value lives, and one write touches exactly that. */
function theClient(): string {
  return frame(
    'the-client',
    `${row(
      `${Array.from({ length: 5 }, (_, at) => step(at * 0.42, box(code('&lt;li&gt;'), 'tight'))).join('')}
       <span class="hpush"></span>
       ${step(2.1, note('~200 bindings recorded'))}`,
    )}
     ${wire(2.4)}
     ${row(
       `${step(2.52, code('one signal write'))}
        <span data-wf class="hflash" style="animation:wf-flash ${CYCLE}s linear infinite">${enc('qty 2 → 3')}</span>
        ${step(3, note('0.31 µs, one node, no component code'))}`,
     )}`,
  )
}

/** Staging paints nowhere, so the figure has to show the staged epoch and the commit separately. */
function navigation(): string {
  return frame(
    'navigation',
    rows([
      row(
        `${code('hover', 'ghost')}${step(0, box(code('epoch staged — paints nowhere'), 'dashed'))}${step(
          0.84,
          pill(stagedClick().staged, 'lit'),
        )}`,
      ),
      row(
        `${code('click', 'ghost')}${step(1.26, box(code('COMMIT — every slot flips at once', 'lit'), 'lit'))}`,
      ),
      row(
        `${code('unstaged', 'ghost')}${step(2.1, note('on the demo’s deliberately slow page'))}${step(
          2.52,
          pill(stagedClick().browser),
        )}`,
      ),
    ]),
  )
}

/** One dispatch, two callers, and the same two functions in the middle of both. */
function intents(): string {
  const nodes: GraphNode[] = [
    {
      id: 'form',
      x: 2,
      y: 6,
      w: 216,
      h: 74,
      title: 'a form posts',
      notes: ['no JavaScript anywhere on the', 'page'],
      at: 0,
    },
    {
      id: 'frame',
      x: 2,
      y: 96,
      w: 216,
      h: 59,
      title: 'INTENT · 0x05',
      notes: ['the same intent, over the channel'],
      at: 0.35,
    },
    {
      id: 'input',
      x: 258,
      y: 50,
      w: 214,
      h: 74,
      title: 'input()',
      notes: ['an intent cannot trust an', 'attribute'],
      accent: true,
      at: 1.1,
    },
    {
      id: 'run',
      x: 512,
      y: 6,
      w: 224,
      h: 59,
      title: 'run()',
      notes: ['the only place a write may happen'],
      accent: true,
      at: 1.9,
    },
    {
      id: 'writes',
      x: 512,
      y: 100,
      w: 224,
      h: 74,
      title: 'writes: [ … ]',
      notes: ['the tags it declared, and only', 'those'],
      at: 2.3,
    },
    {
      id: 'see',
      x: 2,
      y: 216,
      w: 216,
      h: 59,
      title: '303, back where it came',
      notes: ['the answer a browser gets'],
      at: 3.4,
    },
    {
      id: 'ack',
      x: 258,
      y: 216,
      w: 214,
      h: 59,
      title: 'ACK · 0x22',
      notes: ['the answer a channel client gets'],
      at: 3.6,
    },
    {
      id: 'delta',
      x: 512,
      y: 216,
      w: 224,
      h: 74,
      title: 'DELTA · 0x16',
      notes: ['every region under those tags', 'refreshes'],
      accent: true,
      at: 3.8,
    },
  ]
  const edges: GraphEdge[] = [
    { from: 'form', to: 'input', at: 0.6, flow: 1 },
    { from: 'frame', to: 'input', at: 0.75, flow: 1.15 },
    { from: 'input', to: 'run', at: 1.5, flow: 1.9 },
    { from: 'run', to: 'writes', down: true, at: 2, flow: 2.4 },
    { from: 'writes', to: 'delta', down: true, at: 2.9, flow: 3.3 },
    { from: 'input', to: 'see', down: true, at: 3, flow: 3.4 },
    { from: 'writes', to: 'ack', back: true, at: 3.2, flow: 3.6 },
  ]
  return frame('intents', graph(nodes, edges, { height: 300, cycle: 5.4 }))
}

/** The socket, the cycle it turns, and the four things a client says when it opens one. */
function liveRegions(): string {
  const nodes: GraphNode[] = [
    {
      id: 'browser',
      x: 2,
      y: 74,
      w: 200,
      h: 74,
      title: 'the browser',
      notes: ['holds templates, and one base', 'render per region'],
      at: 0,
    },
    {
      id: 'up',
      x: 248,
      y: 6,
      w: 238,
      h: 59,
      title: 'RESIDENT · HELD',
      notes: ['what I already have, named'],
      accent: true,
      at: 0.8,
    },
    {
      id: 'server',
      x: 532,
      y: 74,
      w: 204,
      h: 74,
      title: 'the deployment',
      notes: ['recovers that base, diffs,', 'memoizes'],
      at: 1.6,
    },
    {
      id: 'down',
      x: 248,
      y: 146,
      w: 238,
      h: 74,
      title: 'TPL · DELTA · COMMIT',
      notes: ['a template only if missing, then', 'values'],
      accent: true,
      at: 2.6,
    },
  ]
  const edges: GraphEdge[] = [
    { from: 'browser', to: 'up', at: 0.4, flow: 0.8 },
    { from: 'up', to: 'server', at: 1.2, flow: 1.6 },
    { from: 'server', to: 'down', back: true, at: 2.2, flow: 2.6 },
    { from: 'down', to: 'browser', back: true, at: 3, flow: 3.4 },
  ]
  const codes: readonly [string, string, string][] = [
    ['0x01', 'RESIDENT', 'the template versions it is holding'],
    ['0x02', 'HELD', 'the base render per slot, so a diff has a from'],
    ['0x03', 'REFRESH', 'this region, again, please'],
    ['0x04', 'WARM', 'a hint, and refusable'],
  ]
  return frame(
    'live-regions',
    `${graph(nodes, edges, { height: 232, cycle: 5.4 })}
     <p class="hcap">up · codes below 0x10 — what the client tells the server</p>
     ${rows(
       codes.map(([hex, name, says], at) =>
         step(at * 0.34, row(`${code(hex, 'lit')}${code(name)}${note(says)}`)),
       ),
       true,
     )}`,
  )
}

/** What a page actually downloads: one mark per module, from `weft.budget.json`. Marks are equal height on purpose — that file has no per-module breakdown to draw varying ones from. */
function whatShips(): string {
  const site = siteWeight()
  return frame(
    'what-ships',
    `<div class="hmods">${Array.from(
      { length: site.modules },
      (_, at) =>
        `<span data-wf class="hmod" style="animation:wf-grow ${CYCLE}s cubic-bezier(.2,.7,.3,1) ${(
          at * 0.06
        ).toFixed(2)}s infinite"></span>`,
    ).join('')}</div>
     ${row(
       `${note(`${site.modules} modules, served as written, types stripped`)}
        <span class="hpush"></span>
        ${code(`${site.brotli.toLocaleString('en-US')} B brotli`, 'lit')}`,
     )}
     <p class="hcap">gated by <code>budget({ js, grow })</code>, measured on the real walk over HTTP —
       this framework has no bundler, so there is no bundle to measure instead.</p>`,
  )
}

/** Eleven ports, bound one at a time, because that is what the front door does for you. */
function deploying(): string {
  return frame(
    'deploying',
    `<div class="hports">${Array.from({ length: 11 }, (_, at) =>
      step(at * 0.23, pill(`port ${at + 1} bound`)),
    ).join('')}</div>
     <p class="hcap">No configuration at all for a first deployment. Bind a port and only that behaviour
       changes; a port that is not bound refuses by name rather than approximating.</p>`,
  )
}

/** A region that might live elsewhere, and what happens to the rest when it does not answer. */
function composition(): string {
  return frame(
    'composition',
    `${row(
      `${step(0, box(code('shell — says search')))}${ARROW}${step(
        0.42,
        box(code('registry: this process · a binding · another pod'), 'dashed'),
      )}${ARROW}${step(0.84, pill('REGION search', 'lit'))}`,
    )}
     ${wire()}
     ${row(swap(note('that one region degrades to its declared fallback'), note('the other four are untouched')))}`,
  )
}

/** Three engines, measured directly, and the one that is labelled a proxy rather than a phone. */
function devices(): string {
  const engines: readonly [string, string][] = [
    ['chromium', raceFigure('chromium', 'out-of-order')],
    ['firefox', raceFigure('firefox', 'out-of-order')],
    ['webkit', `${raceFigure('webkit', 'out-of-order')}, a desktop proxy`],
  ]
  return frame(
    'devices',
    rows(
      engines.map(([name, value], at) => step(at * 0.42, row(`${code(name, 'lit')}${LEAD}${code(value)}`))),
    ),
  )
}

/** A minor travels in both directions; a major does not travel at all. */
function versioning(): string {
  return frame(
    'versioning',
    rows([
      row(
        `${code('minor', 'ghost')}${step(0, pill('warp 1.7'))}${ARROW}${step(0.42, pill('warp 1.8'))}${ARROW}${step(
          0.84,
          pill('round-trips', 'lit'),
        )}`,
      ),
      row(
        `${code('major', 'ghost')}${step(1.26, pill('ir 1.x'))}${ARROW}${step(1.68, pill('ir 2.x'))}${ARROW}${step(
          2.1,
          pill('refused, both versions named', 'no'),
        )}`,
      ),
    ]),
  )
}

/** The probe walks the tree, and what it costs the request path is nothing. */
function testing(): string {
  return frame(
    'testing',
    `${rows(
      [
        step(0, code('/ — 1 hop')),
        step(0.42, code('  search — 2 hops')),
        step(0.84, code('    prices — 3 hops', 'lit')),
      ],
      true,
    )}
     <div class="hafter">${row(
       `${code('weft verify --probe', 'lit')}
        ${swap(pill('exit 0'), pill('exit 1 — regions disagree', 'no'))}
        ${note('the probe costs the request path zero bytes')}`,
     )}</div>`,
  )
}

/** One command's answer, because the page below it is the help text parsed. */
function cli(): string {
  return frame(
    'cli',
    rows(
      [
        step(
          0,
          row(
            `${code('$', 'ghost')}${code('weft why /', 'lit')}<span data-wf class="caret" style="animation:wf-caret 1.1s steps(1) infinite"></span>`,
          ),
        ),
        step(0.42, code('  shell   app/layout.tsx → routes/index.tsx')),
        step(0.84, code('  wave 1  header (buffered) · feed (stream)')),
        step(1.26, code('  wave 2  prices needs feed')),
        step(1.68, code('  keys    header: static · feed: shared route:page')),
      ],
      true,
    ),
  )
}

/* ── the dispatcher ───────────────────────────────────────────────────────── */

const HEROES: Record<string, () => string> = {
  'getting-started': gettingStarted,
  'an-application': anApplication,
  fragments,
  components,
  'scoped-styles': scopedStyles,
  layouts,
  'effects-and-cache': effectsAndCache,
  'slots-and-streaming': slotsAndStreaming,
  'where-it-runs': whereItRuns,
  measuring,
  'the-client': theClient,
  navigation,
  intents,
  'live-regions': liveRegions,
  'what-ships': whatShips,
  deploying,
  composition,
  devices,
  versioning,
  testing,
  cli,
}

/** The figure for one page, drawn on demand. `declarations` needs an outside number (pages written), so it's called directly rather than through the table. */
export function hero(slug: string, files = 0): string {
  if (slug === 'declarations') return declarations(files)
  const draw = HEROES[slug]
  return draw ? draw() : ''
}

/** Which slugs have a figure. Read by the test, so a new page cannot quietly ship without one. */
export function drawn(): string[] {
  return [...Object.keys(HEROES), 'declarations']
}
