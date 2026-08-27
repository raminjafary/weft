import { criticalPath, schedule } from '@weft/kernel'
import { escapeHtml } from './escape.ts'
import { caption } from './openers.ts'
import { siteWeight } from './budgets.ts'
import { graph, type GraphEdge, type GraphNode } from './graph.ts'

/**
 * The figure at the top of each guide page: the mechanism, moving.
 *
 * Twenty-two pages, twenty-two figures, and one vocabulary between them — a row that lights when
 * its turn comes, a pill, a bar drawn to scale, a mark travelling an edge. A reader who has read
 * one figure has read how the next one speaks, which is worth more than each being clever.
 *
 * The rule for whether a figure moves at all is that the movement has to *be* the idea. An order of
 * arrival, a size against another size, a value swapped for another, something refused. Where the
 * idea is a shape and not a sequence — a file tree, a nested layout — the figure is still built
 * from the same rows, and the sequence is the order a reader should read them in.
 *
 * Every animated element carries `data-wf`, and every keyframe ends at the state that makes the
 * point, so the reduced-motion version is the finished diagram rather than a blank box.
 */

const enc = escapeHtml

/** One cycle for a hero figure. Long enough to read a six-row sequence without hurrying it. */
const CYCLE = 4.6

/**
 * A row that arrives when its turn comes.
 *
 * This is the whole sequencing primitive: `wf-step` takes an element from 16% opacity to full and
 * holds it there for the rest of the cycle. It never reaches zero — a row at 16% is still legible
 * as a row, so the figure reads as a diagram filling in rather than as content appearing from
 * nowhere.
 */
function step(at: number, body: string): string {
  return `<div data-wf class="hs" style="animation:wf-step ${CYCLE}s linear ${at.toFixed(2)}s infinite">${body}</div>`
}

/**
 * How loud a mark is.
 *
 * `plain` is the default and writes no class at all — a modifier for "unmodified" is a class name
 * that has to be kept from colliding with something for no benefit, and this one did collide.
 */
type Tone = 'plain' | 'lit' | 'no' | 'ghost'

function tone(which: Tone): string {
  return which === 'plain' ? '' : ` ${which}`
}

/** A small labelled block: a slot name, a port, a frame code, a file. */
function pill(text: string, which: Tone = 'plain'): string {
  return `<span class="hp${tone(which)}">${enc(text)}</span>`
}

/** A line of mono text at figure scale, which most of these rows are made of. */
function line(text: string, which: Tone = 'plain'): string {
  return `<span class="hl${tone(which)}">${enc(text)}</span>`
}

/** A bar drawn to scale, with what it is and what it measured. */
function bar(label: string, share: number, value: string, which: Tone, at: number): string {
  return `<div class="hb">
    <span class="hb-name">${enc(label)}</span>
    <span class="hb-track"><span data-wf class="hb-fill${tone(which)}" style="width:${(share * 100).toFixed(
      1,
    )}%;animation:wf-grow ${CYCLE}s cubic-bezier(.2,.7,.3,1) ${at.toFixed(2)}s infinite"></span></span>
    <span class="hb-val${tone(which)}">${enc(value)}</span>
  </div>`
}

/** The frame every hero sits in: the drawing, and the sentence that says what it showed. */
function frame(slug: string, body: string): string {
  const says = caption(slug)
  return `<figure class="hero-fig">
    <div class="hero-fig-in">${body}</div>
    ${says ? `<figcaption>${enc(says)}</figcaption>` : ''}
  </figure>`
}

/** Rows, each arriving in turn. The stagger is computed, so inserting a row retimes the rest. */
function rows(items: readonly string[], gap = 0.42): string {
  return `<div class="hrows">${items.map((body, at) => step(at * gap, body)).join('')}</div>`
}

/* ── the figures ──────────────────────────────────────────────────────────── */

/** What `npm create weft` writes, in the order you would read the folder. */
function gettingStarted(): string {
  const tree: readonly [string, string, number][] = [
    ['my-app/', '21 files', 0],
    ['app/', '', 1],
    ['layout.tsx', 'the document. Its slot holes are what a route fills', 2],
    ['layout.css', 'linked by every page under it', 2],
    ['styles.css', 'the application’s own sheet', 2],
    ['routes/', 'the route table — this subtree is it', 2],
    ['index.tsx', '/', 3],
    ['index.data.ts', 'head, cache policy, loader', 3],
    ['weft.config.ts', 'every line commented out', 1],
  ]
  return frame(
    'getting-started',
    `<p class="hcmd"><span class="prompt">$</span> <span class="cmd">npm create weft my-app</span><span
       data-wf class="caret" style="animation:wf-caret 1.1s steps(1) infinite"></span></p>
     ${rows(
       tree.map(
         ([name, note, depth]) =>
           `<div class="htree" style="padding-inline-start:${depth * 16}px">${line(
             name,
             depth === 0 ? 'lit' : 'plain',
           )}${note ? `<span class="hnote">${enc(note)}</span>` : ''}</div>`,
       ),
       0.26,
     )}`,
  )
}

/**
 * The route table is the file tree, drawn as the walk that produces it.
 *
 * 740 units wide rather than the architecture page's 1320: a guide page's column is 786px, and a
 * figure drawn at the wider scale either scrolls or shrinks its 13px labels to eight.
 */
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

/**
 * A template as what it actually is: finished bytes, with gaps.
 *
 * The constant runs are one width and the holes another, and only the holes light — which is the
 * claim the page makes in one picture. The version comes last because it is a property of the
 * whole strip and not of any segment in it.
 */
function fragments(): string {
  const strip: readonly [number, boolean][] = [
    [2, false],
    [0.8, true],
    [1.4, false],
    [0.8, true],
    [1.4, false],
    [0.8, true],
    [1.4, false],
  ]
  let hole = 0
  const cells = strip
    .map(([flex, isHole]) => {
      if (!isHole) return `<span class="hseg" style="flex:${flex}"></span>`
      hole += 1
      return step(hole * 0.42, `<span class="hseg hole"></span>`).replace(
        'class="hs"',
        `class="hs" style="flex:${flex}"`,
      )
    })
    .join('')
  return frame(
    'fragments',
    `<div class="hstrip">${cells}</div>
     <div class="hstrip-say">
       <span class="hnote">pre-encoded bytes</span><span class="hnote">·</span>
       <span class="hnote">holes, filled per render</span>
       ${step(2.52, `<span class="hl lit">version t_9f4c1ab2 — a hash of its content</span>`)}
     </div>`,
  )
}

/** One fragment inside another, and the flat stream it lowers to. */
function components(): string {
  return frame(
    'components',
    `${rows(
      [
        `<div class="hbox">${line('<Card>')}<span class="hnote">outer template</span></div>`,
        `<div class="hnest"><div class="hbox dashed">${line('children — one hole, any shape')}</div></div>`,
      ],
      0.42,
    )}
     <div class="hwire"><span data-wf class="hdot" style="animation:wf-travel ${CYCLE}s linear .6s infinite"></span></div>
     ${step(1.26, `<div class="hbox lit">${line('one stream of segments · nothing nested at runtime', 'lit')}</div>`)}`,
  )
}

/** The attribute the compiler stamps, shown where it is stamped: into the bytes. */
function scopedStyles(): string {
  return frame(
    'scoped-styles',
    rows(
      [
        `<div class="hbox"><span class="hnote">card.scoped.css — as authored</span>
          ${line('.card { border: 1px solid red }')}${line('.card .body { opacity: 0.7 }')}</div>`,
        `<div class="hbox"><span class="hnote">card.tsx — sealed by the compiler</span>
          ${line('<div data-w-d901a5ad class="card">', 'lit')}</div>`,
        `<div class="hbox"><span class="hnote">on the wire</span>
          ${line('.card[data-w-d901a5ad] { … }', 'lit')}</div>`,
      ],
      0.5,
    ),
  )
}

/** Holes fill outside in, so the figure is three bands nested in that order. */
function layouts(): string {
  return frame(
    'layouts',
    `${step(
      0,
      `<div class="hbox">${line('app/layout.tsx — the document')}
      ${step(
        0.6,
        `<div class="hnest"><div class="hbox">${line('routes/guide/layout.tsx — contents, body, outline')}
          ${step(1.2, `<div class="hnest"><div class="hbox lit">${line('the page — one slot, deep in a chain', 'lit')}</div></div>`)}
        </div></div>`,
      )}
    </div>`,
    )}`,
  )
}

/** A read, and the four things that follow from it with nothing in between to configure. */
function effectsAndCache(): string {
  return frame(
    'effects-and-cache',
    `<div class="hchain">${[
      'const u = ctx.identity()',
      'taint: identity',
      'class: private',
      'key: identity + route:page',
    ]
      .map(
        (part, at) =>
          `${at ? '<span class="harrow">→</span>' : ''}${step(
            at * 0.5,
            `<span class="hl${at === 3 ? ' lit' : ''}">${enc(part)}</span>`,
          )}`,
      )
      .join('')}</div>
     <p class="hnote wide">There is no setter anywhere in the kernel, the plan DSL or the plugin
       surface. The absence is the enforcement.</p>`,
  )
}

/**
 * The two delivery orders, raced on one clock.
 *
 * Both lanes settle at the same instant and carry identical DOM; the only difference is when the
 * fast region became visible, which is the entire claim and the only thing that moves.
 */
function slotsAndStreaming(): string {
  const lane = (
    kind: string,
    says: string,
    bands: readonly { at: string; cls: string; anim: string }[],
    tick: { at: number; label: string; lit: boolean },
  ): string => `<div class="hlane">
      <div class="hlane-head"><span class="hl${tick.lit ? ' lit' : ''}">${enc(kind)}</span>
        <span class="hnote">${enc(says)}</span></div>
      <div class="htrack">
        <span data-wf class="hband base" style="animation:wf-shell 3.6s linear infinite"></span>
        ${bands
          .map(
            (band) =>
              `<span data-wf class="hband ${band.cls}" style="left:${band.at};animation:${band.anim} 3.6s linear infinite"></span>`,
          )
          .join('')}
        <span data-wf class="hplay" style="animation:wf-play 3.6s linear infinite"></span>
        <span data-wf class="htick ${tick.lit ? 'lit' : ''}" style="left:${tick.at}%;animation:${
          tick.lit ? 'wf-tick' : 'wf-tick-late'
        } 3.6s linear infinite">${enc(tick.label)}</span>
      </div>
    </div>`
  return frame(
    'slots-and-streaming',
    `${lane('In order', 'the shell waits', [{ at: '0%', cls: 'slow', anim: 'wf-fast-io' }], {
      at: 96,
      label: '103 ms',
      lit: false,
    })}
     ${lane(
       'Out of order',
       'whatever is ready goes first',
       [
         { at: '0%', cls: 'fast', anim: 'wf-fast-oo' },
         { at: '21%', cls: 'slow', anim: 'wf-slow' },
       ],
       { at: 21, label: '22 ms', lit: true },
     )}`,
  )
}

/** The waves, and what they cost against doing the same work one slot at a time. */
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
      plan.waves.map(
        (wave, at) =>
          `<div class="hwave">${line(`wave ${at + 1}`, 'lit')}${wave
            .map((name) => pill(name))
            .join('')}</div>`,
      ),
      0.84,
    )}
     <div class="hbars">
       ${bar('sequential', 1, `${path.sequentialMs.toFixed(1)} ms`, 'ghost', 0)}
       ${bar('waves', path.ms / path.sequentialMs, `${path.ms.toFixed(1)} ms`, 'lit', 0.32)}
     </div>`,
  )
}

/** What the build wrote, and what it refused to write, with the reason beside each. */
function declarations(files: number): string {
  return frame(
    'declarations',
    `<p class="hcmd"><span class="prompt">$</span> <span class="cmd">weft build</span></p>
     ${rows(
       [
         `<span class="hl lit">${enc(`${files} files written to .weft/static/`)}</span>`,
         `<span class="hl">/play — not a file: reads what you typed</span>`,
         `<span class="hl">/search — not a file: reads route:q</span>`,
       ],
       0.5,
     )}`,
  )
}

/** A recording, and the one decision it is allowed to change. */
function measuring(): string {
  const seen = [
    { name: 'header', ms: 2 },
    { name: 'prices', ms: 6 },
    { name: 'feed', ms: 81 },
    { name: 'related', ms: 78 },
  ]
  const top = Math.max(...seen.map((each) => each.ms))
  return frame(
    'measuring',
    `<div class="hbars">${seen
      .map((each, at) =>
        bar(each.name, each.ms / top, `${each.ms} ms`, each.ms > 40 ? 'lit' : 'plain', at * 0.24),
      )
      .join('')}</div>
     <p class="hnote wide">the next generation plans delivery from it</p>
     <div class="hswap">
       <span data-wf class="hl" style="animation:wf-swap-a ${CYCLE}s linear infinite">feed: buffer</span>
       <span data-wf class="hl lit" style="animation:wf-swap-b ${CYCLE}s linear infinite">feed: stream</span>
     </div>`,
  )
}

/** Adoption, and what one write actually touches. */
function theClient(): string {
  return frame(
    'the-client',
    `<div class="hdom">${Array.from({ length: 5 }, (_, at) =>
      step(at * 0.2, `<span class="hnode${at === 3 ? ' lit' : ''}">&lt;li&gt;</span>`),
    ).join('')}</div>
     ${step(1.2, `<span class="hnote">~200 bindings recorded</span>`)}
     <div class="hwire"><span data-wf class="hdot" style="animation:wf-travel ${CYCLE}s linear 2s infinite"></span></div>
     <div class="hwrite">
       ${step(2.4, `<span class="hl">one signal write</span>`)}
       <span data-wf class="hl lit flash" style="animation:wf-flash ${CYCLE}s linear infinite">qty 2 → 3</span>
       ${step(3, `<span class="hnote">0.31 µs, one node, no component code</span>`)}
     </div>`,
  )
}

/** Staging paints nowhere, so the figure has to show two timelines and one commit. */
function navigation(): string {
  return frame(
    'navigation',
    rows(
      [
        `<div class="hrow">${line('hover')}<span class="hnote">epoch staged — paints nowhere</span>
          <span class="hl lit end">17 ms</span></div>`,
        `<div class="hrow">${line('click')}<span class="hnote">COMMIT — every slot flips at once</span></div>`,
        `<div class="hrow">${line('unstaged', 'ghost')}<span class="hnote">on the demo’s deliberately slow page</span>
          <span class="hl end">606 ms</span></div>`,
      ],
      0.5,
    ),
  )
}

/**
 * One dispatch, two callers, and the same two functions in the middle of both.
 *
 * The bottom row is what each caller gets back, so the two edges into it run backwards across the
 * figure — which is what they are: an answer returning to whoever asked.
 */
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
      title: 'writes: [] — or the tags it names',
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

/**
 * The socket, and the four things a client says when it opens one.
 *
 * A cycle rather than a pipeline: the client names what it holds, the server answers with the
 * smallest thing that will do, and that answer returns to the client. The two closing edges run
 * backwards, which is the shape of the claim — nothing here is a round of polling.
 */
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
     <p class="hnote wide">up · codes below 0x10 — what the client tells the server</p>
     ${rows(
       codes.map(
         ([code, name, says]) =>
           `<div class="hrow">${line(code, 'lit')}${line(name)}<span class="hnote">${enc(says)}</span></div>`,
       ),
       0.34,
     )}`,
  )
}

/**
 * What a page actually downloads: one mark per module, and what they weigh together.
 *
 * The count is `weft.budget.json` — the file the growth cap is a diff of — so it is this site's own
 * walk over HTTP rather than a number about the demo. The marks are the same height on purpose.
 * There is no per-module breakdown in that file, and nineteen bars of varying height would draw a
 * distribution nothing measured: the figure's claim is *how many responses a page fetches*, and the
 * weight is the number beside them.
 */
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
     <div class="hstrip-say">
       <span class="hnote">${site.modules} modules, served as written, comments intact</span>
       <span class="hl lit end">${site.brotli.toLocaleString('en-US')} B brotli</span>
     </div>
     <p class="hnote wide">gated by <code>budget({ js, grow })</code>, measured on the real walk over HTTP
       rather than over a bundle — this framework has no bundler to measure.</p>`,
  )
}

/** Eleven ports, bound one at a time, because that is what the front door does for you. */
function deploying(): string {
  return frame(
    'deploying',
    `<div class="hports">${Array.from({ length: 11 }, (_, at) =>
      step(at * 0.28, `<span class="hp lit">${enc(`port ${at + 1} bound`)}</span>`),
    ).join('')}</div>
     <p class="hnote wide">No configuration at all for a first deployment. Bind a port and only that
       behaviour changes; a port that is not bound refuses by name rather than approximating.</p>`,
  )
}

/** A region that might live elsewhere, and what happens when it does not answer. */
function composition(): string {
  return frame(
    'composition',
    `<div class="hchain">
       ${step(0, `<span class="hl">shell — says search</span>`)}
       <span class="harrow">→</span>
       ${step(0.5, `<span class="hl">registry: this process · a binding · another pod</span>`)}
       <span class="harrow">→</span>
       ${step(1, `<span class="hl lit">REGION search</span>`)}
     </div>
     <div class="hwire"><span data-wf class="hdot" style="animation:wf-travel ${CYCLE}s linear 1.4s infinite"></span></div>
     <div class="hswap">
       <span data-wf class="hl" style="animation:wf-swap-a ${CYCLE}s linear infinite">that one region degrades to its declared fallback</span>
       <span data-wf class="hl lit" style="animation:wf-swap-b ${CYCLE}s linear infinite">the other four are untouched</span>
     </div>`,
  )
}

/** Three engines, measured directly, and the one that is labelled a proxy. */
function devices(): string {
  const engines: readonly [string, string, boolean][] = [
    ['chromium', '22 ms', false],
    ['firefox', '23 ms', false],
    ['webkit', '22 ms, a desktop proxy', true],
  ]
  return frame(
    'devices',
    rows(
      engines.map(
        ([name, value, proxy]) =>
          `<div class="hrow">${line(name)}<span class="hl ${proxy ? 'ghost' : 'lit'} end">${enc(value)}</span></div>`,
      ),
      0.5,
    ),
  )
}

/** A minor travels both ways; a major does not travel at all. */
function versioning(): string {
  return frame(
    'versioning',
    rows(
      [
        `<div class="hrow">${line('minor', 'lit')}${line('warp 1.7')}<span class="harrow">→</span>${line(
          'warp 1.8',
        )}<span class="harrow">→</span><span class="hl lit end">round-trips</span></div>`,
        `<div class="hrow">${line('major', 'no')}${line('ir 1.x')}<span class="harrow">→</span>${line(
          'ir 2.x',
        )}<span class="hl no end">refused, both versions named</span></div>`,
      ],
      0.6,
    ),
  )
}

/** The probe, and what it costs the request path, which is nothing. */
function testing(): string {
  return frame(
    'testing',
    `${rows(
      [
        `<div class="hrow">${line('/')}<span class="hnote">1 hop</span></div>`,
        `<div class="hrow">${line('search')}<span class="hnote">2 hops</span></div>`,
        `<div class="hrow">${line('prices')}<span class="hnote">3 hops</span></div>`,
      ],
      0.34,
    )}
     <p class="hcmd"><span class="prompt">$</span> <span class="cmd">weft verify --probe</span></p>
     <div class="hswap">
       <span data-wf class="hl lit" style="animation:wf-swap-a ${CYCLE}s linear infinite">exit 0</span>
       <span data-wf class="hl no" style="animation:wf-swap-b ${CYCLE}s linear infinite">exit 1 — regions disagree</span>
     </div>
     <p class="hnote wide">the probe costs the request path zero bytes</p>`,
  )
}

/** One command's answer, because the page below is the help text parsed. */
function cli(): string {
  return frame(
    'cli',
    `<p class="hcmd"><span class="prompt">$</span> <span class="cmd">weft why /</span><span
       data-wf class="caret" style="animation:wf-caret 1.1s steps(1) infinite"></span></p>
     ${rows(
       [
         `<span class="hl">shell app/layout.tsx → routes/index.tsx</span>`,
         `<span class="hl">wave 1  header (buffered) · feed (stream)</span>`,
         `<span class="hl">wave 2  prices needs feed</span>`,
         `<span class="hl lit">keys  header: static · feed: shared route:page</span>`,
       ],
       0.42,
     )}`,
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

/**
 * The figure for one page, drawn on demand.
 *
 * `declarations` is the one that needs a number from outside itself — how many pages this build
 * wrote out — so it is not in the table and is called with it.
 */
export function hero(slug: string, files = 0): string {
  if (slug === 'declarations') return declarations(files)
  const draw = HEROES[slug]
  return draw ? draw() : ''
}

/** Which slugs have a figure. Read by the test, so a new page cannot quietly ship without one. */
export function drawn(): string[] {
  return [...Object.keys(HEROES), 'declarations']
}
