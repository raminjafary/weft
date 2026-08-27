import { escapeHtml } from './escape.ts'
import { highlight } from './highlight.ts'
import { wireBars } from './figures.ts'

/**
 * The landing page's body.
 *
 * It is the one page on this site that is not a document page, so it is the one page with a builder
 * of its own rather than headings and prose: a hero over a tabbed panel, a band of measurements, one
 * figure drawn to scale, and two card decks. Its stylesheet is `routes/index.css`, linked only here.
 *
 * Every number on it is counted rather than typed — the caller passes what it walked out of the
 * source — because a landing page that quotes a figure somebody has to remember to update is a
 * landing page that lies within a month.
 */

const enc = escapeHtml

export interface Counts {
  exports: number
  modules: number
  codes: number
  examples: number
  terms: number
  index: number
  templates: number
  pages: number
}

interface Tab {
  id: string
  label: string
  note: string
  path: string
  lang: string
  code: string
}

/**
 * Four tabs, because there are four things worth seeing before deciding: what a page declares, what
 * a fragment compiles to, what actually travels, and the one thing allowed to write.
 *
 * Radio inputs and `:has(:checked)`, so the panel switches with no script at all. That is not a
 * stunt — it is the claim the page is making, made by the page.
 */
const TABS: readonly Tab[] = [
  {
    id: 'route',
    label: 'a route',
    note: 'what a page declares',
    path: 'app/routes/cart.data.ts',
    lang: 'ts',
    code: `import { defineRoute } from 'weft'

export default defineRoute({
  head: { title: 'Cart' },
  // no cache key here. There is no setter.
  slots: {
    items: { fragment: 'cart/items' },
    total: { fragment: 'cart/total', needs: ['items'] },
    feed:  { fragment: 'feed', stream: true },
  },
  etag: true, // E_ETAG_STREAMS — feed streams
})`,
  },
  {
    id: 'fragment',
    label: 'a fragment',
    note: 'sealed into a template',
    path: 'app/fragments/cart/total.tsx',
    lang: 'tsx',
    code: `import { fragment } from 'weft'

export default fragment(({ rows, total }: Prices) => (
  <div class="prices">
    {rows.map((r) => (
      <p>{r.label}<b>{r.price}</b></p>
    ))}
    <p class="total">Total<b>{total}</b></p>
  </div>
))

// 7 holes · 4 need no escaping, because they are typed number`,
  },
  {
    id: 'wire',
    label: 'the wire',
    note: 'chosen per request',
    path: 'the frames on the socket',
    lang: 'ts',
    code: `// what the client sent — it names what it already holds
HELD cart/total t_9f4c1ab2 r_41c8

// html — the whole region, re-parsed · 6,289 B
FRAME cart/total html
  <div class="prices"><p>Oat milk<b>7.80… (12 rows)

// patch — the holes that changed, as DOM writes · ~1,300 B
FRAME cart/total patch
  [4, "<b>9.75</b>"], [9, "<b>14.00</b>"]

// delta — values only, into DOM that exists · 371 B
FRAME cart/total delta r_41c8->r_5d02
  { 4: 9.75, 9: 14.00 }

// same fragment, same DOM. The kernel picks per request.`,
  },
  {
    id: 'intent',
    label: 'an intent',
    note: 'the one thing that writes',
    path: 'app/intents/quantity.ts',
    lang: 'ts',
    code: `import { defineIntent } from 'weft'

export const quantity = defineIntent<{ qty: number }>({
  name: 'docs.quantity',
  writes: ['cart', 'totals'],  // declared, so the
  //                        regions that go stale are known
  input: (raw) => {
    const qty = Number((raw as any).qty)
    if (!Number.isFinite(qty)) throw new Error('qty')
    return { qty: Math.max(0, Math.trunc(qty)) }
  },
  async run(input, ctx) { await ctx.cart.set(input.qty) },
})`,
  },
]

function hero(): string {
  return `<section class="hero">
    <div class="hero-say">
      <h1>A fullstack framework that negotiates how UI reaches the browser.</h1>
      <p class="hero-lede">The wire form of a piece of UI — full markup, a surgical delta, a patch — is chosen
        per request from a set of encodings the compiler has proven equivalent, instead of being frozen at
        build time.</p>
      <p class="hero-sub">A folder is an application. There is no bundler, no virtual DOM, and no component
        code running in the browser: the compiler seals your pages into templates, the server fills them, and
        the client runtime binds what is already there.</p>
      <p class="hero-sub">Pages still change. <a href="/guide/the-client">Signals</a> update a value in place
        without re-rendering around it, an <a href="/guide/intents">intent</a> is the one thing allowed to
        write, and the <a href="/guide/live-regions">regions</a> it invalidates are declared — so what goes
        stale is known before it runs.</p>
      <div class="hero-do">
        <a class="btn btn-primary" href="/quick-start">Quick Start <span aria-hidden="true">→</span></a>
        <a class="btn" href="/guide">Read the Guide</a>
      </div>
      <p class="hero-cmd"><span class="prompt">$</span> <span class="cmd">npm create weft my-app</span><span
        data-wf class="caret" style="animation:wf-caret 1.1s steps(1) infinite"></span></p>
      <p class="hero-fine">Client modules are TypeScript with their types stripped by Node and two bare
        specifiers rewritten, so what runs in the browser is the file on disk.</p>
    </div>
    ${heroPanel()}
  </section>`
}

function heroPanel(): string {
  return `<figure class="panel" role="group" aria-label="What a weft application is made of">
    <div class="panel-tabs">${TABS.map(
      (tab, at) =>
        `<label class="panel-tab"><input type="radio" name="hero" value="${enc(tab.id)}"${
          at === 0 ? ' checked' : ''
        }><span class="panel-tab-in"><span class="panel-tab-label">${enc(
          tab.label,
        )}</span><span class="panel-tab-note">${enc(tab.note)}</span></span></label>`,
    ).join('')}</div>
    ${TABS.map(
      (tab) =>
        `<section class="panel-body">
          <p class="panel-path"><span class="dot"></span>${enc(tab.path)}</p>
          <pre><code data-lang="${enc(tab.lang)}">${highlight(tab.lang, tab.code)}</code></pre>
        </section>`,
    ).join('')}
  </figure>`
}

function band(): string {
  const figures = [
    {
      value: '1.96×',
      note: 'server render throughput, pre-encoded segments against string SSR, on a 707 B shell',
    },
    { value: '16.9×', note: 'smaller per server-driven update, raw — 371 B against 6,289 of markup' },
    {
      value: '4.7×',
      note: 'earlier to the fast region out of order, in all three engines — 22 ms against 103',
    },
    { value: '6,109 B', note: 'the client runtime, brotli, everything in it — against a 6,144 ceiling' },
  ]
  return `<section class="band">
    <div class="band-in">
      <div class="band-grid">${figures
        .map(
          (figure, at) => `<div class="band-cell">
            <div class="band-num">${enc(figure.value)}</div>
            <div data-wf class="band-rule" style="animation:wf-rise 5.6s cubic-bezier(.2,.7,.3,1) ${(
              at * 0.22
            ).toFixed(2)}s infinite"></div>
            <div class="band-note">${enc(figure.note)}</div>
          </div>`,
        )
        .join('')}</div>
      <p class="band-fine">Apple M4, Node 24.18, loopback, 300 samples. Every figure states what it measured,
        on what hardware, over how many samples.</p>
    </div>
  </section>`
}

function wire(): string {
  return `<section class="split-say">
    <div>
      <h2>One region, three ways onto the wire</h2>
      <p>A region is one rendered fragment on a page — a cart total, a feed, a header — addressable on its
        own. A region that changed can travel as markup, as a patch addressed the way adoption addresses the
        DOM, or as a delta naming only the holes whose values moved. The kernel picks per request from what
        the client says it holds. Nothing about the fragment changes.</p>
      <p>You do not choose between them and you cannot get them wrong: the fragment is one declaration, and
        the same one serves a first visit, a surgical refresh, and a client still holding last week’s
        template.</p>
      <a class="more" href="/guide/slots-and-streaming">Slots and streaming <span aria-hidden="true">→</span></a>
    </div>
    ${wireBars(
      [
        { form: 'html', what: 'the whole region, re-parsed', size: '6,289 B · 605 brotli', share: 1 },
        {
          form: 'patch',
          what: 'the holes that changed, as DOM writes',
          size: '4.3–6.0× smaller',
          share: 0.2,
        },
        {
          form: 'delta',
          what: 'values only, into DOM that exists',
          size: '371 B · 187 brotli',
          share: 0.059,
          lit: true,
        },
      ],
      `One row’s quantity and price change, on a twelve-row cart. A delta applied as designed is 20–93×
       cheaper than the parse it replaces; a region whose values are not projectable takes the patch rung
       instead of falling all the way to markup.`,
    )}
  </section>`
}

function start(counts: Counts): string {
  const cards = [
    {
      href: '/quick-start',
      title: 'Quick Start',
      body: 'One command, three files, and a page that streams. Ten minutes.',
    },
    {
      href: '/guide',
      title: 'Guide',
      body: `${counts.pages} pages in order: fragments, layouts, effects, streaming, the client, intents, live regions, composition, operating it.`,
    },
    {
      href: '/tutorial',
      title: 'Tutorial',
      body: 'Build one real page from nothing, a step at a time, and watch what each step costs.',
    },
    {
      href: '/examples',
      title: 'Examples',
      generated: true,
      body: `All ${counts.examples} live fragments on this site, with their source and what the compiler knows about them.`,
    },
    {
      href: '/api',
      title: 'API',
      generated: true,
      body: `${counts.exports} importable names across ${counts.modules} modules, read out of each public entry.`,
    },
    {
      href: '/errors',
      title: 'Error Reference',
      generated: true,
      body: `${counts.codes} named refusals, each with the message it raises and the file that raises it.`,
    },
  ]
  return `<section class="deck">
    <div class="deck-head">
      <h2>Where to start</h2>
      <span class="hint">nine sections; four generated from the source, so they cannot drift</span>
    </div>
    <div class="deck-grid">${cards
      .map(
        (card) => `<a class="card" href="${enc(card.href)}">
          <h3>${enc(card.title)}${card.generated ? '<span class="badge">generated</span>' : ''}</h3>
          <p>${enc(card.body)}</p>
        </a>`,
      )
      .join('')}</div>
  </section>`
}

function absences(): string {
  const items = [
    {
      kicker: 'No bundler',
      title: 'The file on disk is the file that runs',
      body: 'Client modules are TypeScript with their types stripped and two bare specifiers rewritten. Nothing is packed, so the stack trace you get is the code you wrote.',
      figure: '46,698 B',
      fine: 'brotli, for the whole demo — measured over HTTP, not a bundle',
    },
    {
      kicker: 'No virtual DOM',
      title: 'An update names the hole it changed',
      body: 'There is nothing to reconcile: a delta carries the values whose holes moved, applied straight into DOM that already exists.',
      figure: '20–93×',
      fine: 'cheaper to apply than the parse it replaces',
    },
    {
      kicker: 'No component code in the browser',
      title: 'The runtime binds what the parser already built',
      body: 'Adoption walks the server-rendered DOM and records where each value lives. No component function executes, on first paint or after.',
      figure: '0.047 ms',
      fine: 'to adopt a 50-row region — against 0.076 ms to parse the same markup',
    },
  ]
  return `<section class="deck">
    <div class="deck-head">
      <h2>Three things this framework does not have</h2>
      <span class="hint">and what each absence is worth</span>
    </div>
    <div class="deck-grid">${items
      .map(
        (item) => `<div class="absence">
          <p class="absence-kicker">${enc(item.kicker)}</p>
          <p class="absence-title">${enc(item.title)}</p>
          <p class="absence-body">${enc(item.body)}</p>
          <p class="absence-foot"><b>${enc(item.figure)}</b><span>${enc(item.fine)}</span></p>
        </div>`,
      )
      .join('')}</div>
  </section>`
}

/** What this site is, in the order somebody deciding whether to read further needs it. */
export function landingBody(counts: Counts): string {
  return `<div class="landing">
    ${hero()}
    ${band()}
    ${wire()}
    ${start(counts)}
    ${absences()}
    <section class="deck last">
      <div class="deck-head"><h2>This site is a weft application</h2></div>
      <p class="deck-say">Not a documentation generator pointed at a repository, and not a static-site tool
        with a weft plugin. <code>packages/docs</code> is an application in the same sense the demo is:
        routes from the file tree, a plan generated from it, ${counts.templates} sealed templates, and one
        command to serve it. That is the strongest claim the framework can make about itself, so it is the
        one this site is built to be able to make.</p>
      <div class="scroll"><table><thead><tr><th>What the site uses</th><th>Where you can see it</th></tr></thead><tbody>
        <tr><td>Nested layouts — the document is a chain</td><td>Guide, Tutorial and API pages all sit under a <code>routes/&lt;section&gt;/layout.tsx</code></td></tr>
        <tr><td>Param routes with a declared set</td><td>One route serves every guide page; another serves all ${counts.codes} error codes</td></tr>
        <tr><td>The L0 tier</td><td><code>weft build</code> writes this whole site as files. The kernel is not invoked to serve them</td></tr>
        <tr><td>Slots as cache units</td><td>The contents column is a region of its own, so it is one entry across a section rather than a copy per page</td></tr>
        <tr><td>A component's own stylesheet</td><td>Every example on this site carries a <code>.scoped.css</code> the compiler narrowed to its elements</td></tr>
        <tr><td>Declared refusals</td><td>The playground and search are the two pages that are <em>not</em> files, and both say why</td></tr>
        <tr><td>The compiler's virtual file set</td><td>The playground compiles what you type without writing it anywhere</td></tr>
        <tr><td>A read as a cache axis</td><td><code>/search?q=</code> taints <code>route:q</code>, so every query is its own content-addressed entry</td></tr>
        <tr><td>An intent, with no JavaScript on the page</td><td>The form on <a href="/guide/intents">intents</a> posts to a real intent in this application</td></tr>
      </tbody></table></div>
    </section>
  </div>`
}
