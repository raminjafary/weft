import { baseRenderId, clientView, deltaPayload, render, type Values } from '@weft/ir'
import { explain, field, panel, pick, pre, press, readout, slider } from '../pages.ts'
import { numeric, type StationHandler } from './kind.ts'
import { adoptScript, allTemplates, fragmentIR } from 'weft'

const n = (v: number): string => v.toLocaleString('en-US')

/**
 * The client stations.
 *
 * Each one server-renders the same interactive fragment and ships the client's view of its
 * template beside it — everything except the bytes the browser already has. Adoption then happens
 * in the browser, from the real runtime, and the readout is what it cost.
 *
 * There is no component code on the wire. `interactive.tsx` has a signal, two derived values and an
 * intent reference, and what the client receives is a wiring table, an expression tree and a
 * six-character id.
 */
async function interactive(values: Values): Promise<{ html: string; adopt: string; base: string }> {
  const fragment = fragmentIR('fragment:interactive')
  const html = new TextDecoder().decode(render(fragment.entry, values, fragment.resolve))
  return {
    html: `<div class="card"><div data-weft-slot="interactive">${html}</div></div>`,
    // The framework's own payload, not a copy of it. These stations are *about* what the client
    // receives, so building a second one here would mean showing you a payload the runtime does
    // not read — which looks right and does nothing.
    adopt: adoptScript('interactive', fragment, values) ?? '',
    base: baseRenderId(fragment.entry, values),
  }
}

const VALUES = (unitPrice: number): Values =>
  ({ sku: 'RICE-5K', name: 'Amber rice, 5 kg', unitPrice, qty: 1 }) as unknown as Values

export const adoption: StationHandler = async (ctx) => {
  const price = numeric(ctx, 'price', 12000, 100, 90000)
  const fragment = fragmentIR('fragment:interactive')
  const region = await interactive(VALUES(price))
  const view = clientView(fragment.entry)
  const bytes = new TextEncoder().encode(JSON.stringify(view)).length

  return {
    panel: panel(
      [
        field('unit price', slider('adopt-price', 100, 90000, price, 100)),
        press('adopt-go', 'render again'),
      ].join(''),
      'Type in the quantity box. Nothing was mounted, no component ran, and the numbers still move.',
    ),
    body: async () =>
      `${region.html}${region.adopt}` +
      (await readout(
        'What adoption cost',
        [
          {
            label: 'wiring entries',
            value: String(fragment.entry.wiring.length),
            note: fragment.entry.wiring.map((w) => `${w.op}:${w.binding || w.event}`).join(' · '),
            state: 'within',
          },
          {
            label: 'components mounted',
            value: '0',
            note: 'adoption walks marker comments and follows element paths by index. There is no component code on the wire to run',
            state: 'within',
          },
          {
            label: 'client template',
            value: `${n(bytes)} B`,
            note: 'holes, wiring and derived expressions — everything except the markup the browser already has',
          },
          {
            label: 'signals',
            value: String(fragment.entry.signals.length),
            note: fragment.entry.signals.map((s) => `${s.id}=${String(s.init)}`).join(', '),
          },
          {
            label: 'intent references',
            value: String(fragment.entry.wiring.filter((w) => w.op === 'event').length),
            note: 'an event lowers to an opaque id, so the client names six hex characters rather than carrying a closure',
          },
        ],
        {
          what: `A server-rendered region becoming interactive. One pass collects the marker comments, element paths are followed by index, and the result is a table from binding to the node that holds it — so the cost is a function of the number of bindings, not of the number of components.`,
          from: 'adopt() in @weft/client, running in your browser on the region above',
          caveat:
            'The byte figure is the client template for this one fragment, uncompressed. On a repeat visit it is not sent at all, which is the residency station.',
          tryThis:
            'Type a quantity. The total and the “over nine” flag both update, and neither is a component re-render.',
        },
      )),
  }
}

export const signals: StationHandler = async () => {
  const fragment = fragmentIR('fragment:interactive')
  const region = await interactive(VALUES(12000))
  const readers = fragment.entry.wiring.filter((w) => w.binding === 'qty')

  return {
    panel: panel(
      '',
      'One signal, several nodes. Type in the box and watch every node that reads it move together.',
    ),
    body: async () =>
      `${region.html}${region.adopt}` +
      (await readout(
        'One signal, and every node that reads it',
        [
          {
            label: 'signal',
            value: 'qty',
            note: `declared in the fragment as signal(1), type ${fragment.entry.signals[0]?.type}`,
          },
          {
            label: 'nodes that read it directly',
            value: String(readers.length),
            note: readers
              .map((w) => `${w.op}${w.attr ? `:${w.attr}` : ''} at [${w.path.join(',')}]`)
              .join(' · '),
            state: 'within',
          },
          {
            label: 'derived values that read it',
            value: String(fragment.entry.derived.length),
            note:
              fragment.entry.derived.map((d) => d.id).join(', ') +
              ' — recomputed only when something they read changed',
          },
          {
            label: 'DOM writes per signal write',
            value: 'one per reader that actually changed',
            note: 'a write that lands on the same value writes nothing: the graph compares before it touches the DOM',
            state: 'within',
          },
        ],
        {
          what: `A signal is a value with a list of nodes that read it, built at adoption from the wiring table. Writing it walks that list. There is no diffing, no reconciliation and no component boundary involved — which is why the cost is the number of readers rather than the size of the subtree.`,
          from: 'the real signal and wiring declarations of interactive.tsx, plus @weft/client running above',
          caveat:
            'This counts declared readers. Whether a write reaches the DOM depends on whether the value changed, which the derived-values station is about.',
          tryThis: 'Set the quantity to the same number twice. The second one changes nothing.',
        },
      )),
  }
}

export const derived: StationHandler = async () => {
  const fragment = fragmentIR('fragment:interactive')
  const region = await interactive(VALUES(12000))
  const rows = fragment.entry.derived.map((d) => ({
    label: d.id,
    value: JSON.stringify(d.expr),
    note: 'the expression itself, on the wire. Not compiled to a function, so the client evaluates the same tree the server did',
  }))

  return {
    panel: panel(
      '',
      'The total and the “over nine” flag are both derived. Neither is a component and neither ships code.',
    ),
    body: async () =>
      `${region.html}${region.adopt}` +
      (await readout(
        'Two derived values, as data',
        [
          ...rows,
          {
            label: 'operator set',
            value: 'closed',
            note: 'everything in it is total over JSON values and free of effects, so an evaluator on either side is a switch with no escape hatch',
            state: 'within',
          },
          {
            label: 'who owns them',
            value: 'the client, because they reach a signal',
            note: 'the server renders them once from the signal’s initial value and then never speaks about them again — a delta carrying one would overwrite what the user had already done to it',
            state: 'within',
          },
        ],
        {
          what: `A derived value is an encoded expression rather than compiled code. That is what lets a value recompute on the client without shipping a component: the wire carries the tree, and both sides evaluate it with the same closed operator set.`,
          from: 'the real derived declarations of interactive.tsx, from compileFiles()',
          caveat:
            'A derived value that reaches a signal is client-owned and the server stops talking about it. One that reads only props is resolved once, at render, and never appears on the client at all.',
          tryThis: 'Type a quantity above and watch both derived values update from one signal write.',
        },
      )),
  }
}

export const controls: StationHandler = async (ctx) => {
  const attrOnly = ctx.query('mode') === 'attribute'
  const region = await interactive(VALUES(12000))
  const prop = fragmentIR('fragment:interactive').entry.wiring.find((w) => w.op === 'prop')

  return {
    panel: panel(
      [
        field('write mode', pick('ctrl-mode', ['prop', 'attribute'], attrOnly ? 'attribute' : 'prop')),
        press('ctrl-go', 'switch'),
      ].join(''),
      'Type into the box, then press the button. In attribute mode your edit disappears; in prop mode it does not.',
    ),
    body: async () =>
      `${region.html}${region.adopt}` +
      (await readout(
        'A control that survives a user’s edit',
        [
          {
            label: 'wiring op',
            value: prop?.op ?? 'none',
            note: prop ? `writes the ${prop.attr} property of the node at [${prop.path.join(',')}]` : '',
            state: 'within',
          },
          {
            label: 'why not the attribute',
            value: 'they stop agreeing',
            note: 'once a user has typed, an input’s value attribute is its default and its value property is what is on screen. Writing the attribute changes nothing the user can see',
            state: 'over',
          },
          {
            label: 'how the compiler knows',
            value: 'from the element and the attribute',
            note: 'value on an input is a property binding; the same expression on a div is an attribute. It is decided at compile time, not guessed at runtime',
          },
        ],
        {
          what: `The bug this fixes is invisible until a user has typed. A server render sets an input's value attribute; the browser copies it to the property once. From then on the two disagree, and a framework that pushes updates to the attribute silently stops updating the control.`,
          from: 'the real wiring table of interactive.tsx; the write happens in @weft/client',
          caveat:
            'This station shows the declaration. The DOM behaviour is in your browser above — the mode switch is a page reload, so type after it loads.',
          tryThis:
            'Type 7 in the box, then press the button. The value the server rendered is 1, and what you see afterwards is the difference.',
        },
      )),
  }
}

export const deltas: StationHandler = async (ctx) => {
  const price = numeric(ctx, 'price', 12000, 100, 90000)
  const fragment = fragmentIR('fragment:interactive')
  const before = VALUES(12000)
  const after = VALUES(price)
  const base = baseRenderId(fragment.entry, before)
  const payload = deltaPayload(fragment.entry, base, before, after, fragment.resolve)
  const full = render(fragment.entry, after, fragment.resolve)
  const region = await interactive(before)

  return {
    panel: panel(
      [
        field('new unit price', slider('delta-price', 100, 90000, price, 100)),
        press('delta-go', 'diff'),
      ].join(''),
      'The region above is the base render. The payload below is everything the server would send to move it.',
    ),
    body: async () =>
      `${region.html}${region.adopt}` +
      (await readout(
        'One changed value',
        [
          {
            label: 'changed paths',
            value: String(Object.keys(payload.changed).length),
            note: Object.keys(payload.changed).join(', ') || 'nothing changed',
          },
          {
            label: 'delta bytes',
            value: `${n(JSON.stringify(payload.changed).length)} B`,
            note: 'only the values that changed, addressed by binding path',
            state: 'within',
          },
          {
            label: 'a full re-render',
            value: `${n(full.length)} B`,
            note: 'the markup the delta replaces, which also has to be parsed on arrival',
            state: 'over',
          },
          {
            label: 'DOM writes',
            value: String(Object.keys(payload.changed).length),
            note: 'one per changed value. No region is re-projected and no markup is parsed, which is only possible because every hole carries its own addressing',
            state: 'within',
          },
          {
            label: 'base',
            value: payload.base.slice(0, 16),
            note: 'a delta is only applicable to the render it was computed against — a mismatch is refused rather than best-efforted',
          },
        ],
        {
          what: `A delta is the set of values that changed, keyed by the binding path that holds them. Applying one is one DOM write per entry: nothing is re-parsed and no region is re-projected, because the addressing came from the compiler rather than from a diff.`,
          from: 'deltaPayload() in @weft/ir, over the real interactive.tsx and the values above',
          caveat:
            'The comparison with a full render is a byte comparison. The apply-cost comparison is a browser measurement and lives in the benchmark harness, not here.',
          tryThis:
            'Change the price a little and then a lot. The delta is the same size either way, because it is one value.',
        },
      )),
    readout: pre(JSON.stringify(payload, null, 2)),
  }
}

export const residency: StationHandler = async () => {
  const templates = allTemplates()
  const totalBytes = templates.reduce(
    (sum, t) => sum + new TextEncoder().encode(JSON.stringify(clientView(t))).length,
    0,
  )
  return {
    panel: panel(
      ['<button type="button" data-weft-forget>forget everything</button>'].join(''),
      'The button clears the IndexedDB store the resident templates live in, so the next load is a cold visit.',
    ),
    body: async () =>
      readout(
        'What a returning visitor does not have to receive',
        [
          {
            label: 'templates in this demo',
            value: String(templates.length),
            note: 'every fragment and every nested row template',
          },
          {
            label: 'client views, uncompressed',
            value: `${n(totalBytes)} B`,
            note: 'what a cold visit receives as TPL frames, and a warm one does not receive at all',
            state: 'over',
          },
          {
            label: 'held right now',
            value: '<span data-weft-resident class="mono">reading…</span>',
            note: 'read from your browser’s store on load',
          },
          {
            label: 'where they live',
            value: 'IndexedDB',
            note: 'not a service worker: WKWebView gates those behind app-bound domains and in-app browsers often suppress them, so the tier a repeat-visit claim rests on has to be one generic webviews actually have',
          },
          {
            label: 'how the set is advertised',
            value: 'a coarse digest',
            note: 'only a prefix of each version, because a precise list of held templates is an identifying surface. Still not coarse enough for production, and the repo says so',
          },
        ],
        {
          what: `Resident templates are the repeat-visit story: on a second visit the server sends no TPL frames at all, so the only work left is adoption. The numbers here are what this demo's templates weigh and what your browser is currently holding.`,
          from: 'clientView() in @weft/ir for the sizes; openResident() in @weft/client for what you hold',
          caveat:
            'When there is no IndexedDB the store degrades to memory: correctness is unaffected and the second visit simply pays what the first one did.',
          tryThis: 'Press forget, then reload. Then reload again without pressing it.',
        },
      ),
  }
}

export const transport: StationHandler = async () => {
  return {
    panel: panel(
      ['<span data-channel="1" hidden></span>', press('transport-refresh', 'ask for a refresh')].join(''),
      'A channel is open on this page. Every frame in either direction is logged below, unedited.',
    ),
    body: `<div class="card">
        <p class="hint">channel: <span data-weft-stat="state" class="mono">idle</span> · <span data-weft-stat="writes" class="mono">0 DOM writes</span></p>
        <div class="card log" data-weft-log></div>
      </div>
      ${explain({
        what: `The live channel. Three bindings carry the same frames — a long-lived GET with discrete POSTs up, an SSE stream, and a WebSocket — and the state machine above them does not know which one it is talking to. This page uses the first, because it is the one that needs no upgrade and no second connection type.`,
        from: 'createHub() in @weft/kernel and channelHandlers() in @weft/adapters, on this server',
        caveat:
          'SSE cannot carry binary, so it uses the text framing and pays base64 on every rendered body — which is why it is not the default. And the two half-duplex bindings answer on the *other* connection, so an upstream POST after the downstream has gone is E_NO_DOWNSTREAM rather than a silent 200.',
        tryThis:
          'Open /app/feed in a second tab and press “tick once” there. Both tabs are told, and only the first one to ask pays for the delta.',
      })}`,
  }
}

export const intents: StationHandler = async () => {
  return {
    panel: panel(
      [
        '<span data-channel="1" hidden></span>',
        field('sku', pick('cart-sku', ['RICE-5K', 'DATE-1K', 'OIL-2L', 'TEA-500', 'SUGAR-2K'])),
        press('cart-add', 'add (optimistic)'),
        press('cart-fail', 'add, but make it fail'),
        `<form method="post" action="/i/cart.add" class="controls">
           <input type="hidden" name="sku" value="OIL-2L">
           <button type="submit">add with no JavaScript</button>
         </form>`,
      ].join(''),
      'Three paths to the same intent: optimistic over the channel, deliberately failing, and a plain form post.',
    ),
    body: `<div class="card">
        <p class="hint">channel: <span data-weft-stat="state" class="mono">idle</span></p>
        <div class="card log" data-weft-log></div>
      </div>
      ${explain({
        what: `An intent is the only thing in this framework allowed to write, and it declares the tags it may invalidate — an undeclared one throws, in production, because an undeclared write is a cache invalidation nobody can predict from reading the code. Watch the frame log: the optimistic path sends INTENT with an epoch, gets an ACK, and the server stages the real values into that same epoch and commits, so the guess is replaced in one paint. The failing path gets ok=false and no commit, and the client discards the epoch — nothing painted, so nothing has to be un-painted.`,
        from: 'createIntentDispatch() and serveIntent() in @weft/kernel; the cart lives in demo/src/channel.ts',
        caveat:
          'An unchecked capability is refused rather than allowed: an intent declaring one with no check bound is E_NO_CAPABILITY_CHECK. Signed intents and a real capability model are phase 7 and do not exist yet.',
        tryThis:
          'Press the failing one and read the ACK. Then use the plain form: it answers 303 and you land back here with the cart changed.',
      })}`,
    readout: pre(`POST /i/cart.add          → 303, back where the form was      (no JavaScript)
POST /i/cart.add          → 200 { ok, invalidated, refresh }  (fetch)
INTENT i=cart.add epoch=… → ACK ok=true  → DELTA epoch=… → COMMIT   (channel)
INTENT i=cart.add epoch=… → ACK ok=false                            (discard the epoch)`),
  }
}
