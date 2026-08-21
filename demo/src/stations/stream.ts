import { render, type Values } from '../../../packages/ir/src/index.ts'
import { createEpochs, fillerSize, splitAtSlots } from '../../../packages/kernel/src/index.ts'
import { frame, type Frame } from '../../../packages/warp/src/index.ts'
import { compileDemo, listBinding } from '../compile.ts'
import { feedItems } from '../data.ts'
import { field, panel, pick, pre, press, readout, slider } from '../pages.ts'
import { numeric, type StationHandler } from './kind.ts'

const n = (v: number): string => v.toLocaleString('en-US')

/**
 * Streaming, and the two stations that only mean anything next to each other.
 *
 * These pages report the shape of the response rather than simulating it: the shell of this very
 * page was cut at its slot holes by `splitAtSlots`, and the numbers below are the sizes of those
 * cuts. A latency slider changes what the server waits for, so the effect is in the response you
 * are reading rather than in an animation.
 */
export const streaming: StationHandler = async (ctx) => {
  const slow = numeric(ctx, 'slow', 400, 0, 2000)
  const compiled = await compileDemo()
  const shell = compiled.shell
  const split = splitAtSlots(
    shell.entry,
    {
      title: 'x',
      css: '/demo.css',
      runtime: '/demo/boot.ts',
      heading: 'Streaming',
      status: 'live',
      shows: '',
      control: '',
      nav: [],
    } as unknown as Values,
    shell.resolve,
  )
  const first = split.chunks[0]?.length ?? 0
  const total = split.chunks.reduce((sum, c) => sum + c.length, 0)

  return {
    panel: panel(
      [
        field('slow region (ms)', slider('stream-slow', 0, 2000, slow, 50)),
        press('stream-go', 'reload'),
        `<a class="pill" href="/app/dashboard?slow=${slow}">see it on the dashboard</a>`,
      ].join(''),
      'The dashboard is the live version: four panels, four latencies, and a first byte that does not wait for any of them.',
    ),
    body: async () =>
      readout(
        'How this page was cut',
        [
          {
            label: 'slot holes',
            value: String(split.slots.length),
            note: split.slots.join(', ') + ' — every one is a point the server can send bytes before',
          },
          {
            label: 'bytes before the first slot',
            value: `${n(first)} B`,
            note: 'sent before the server knows anything about the slow work. This is what the first byte is',
            state: 'within',
          },
          {
            label: 'shell total',
            value: `${n(total)} B`,
            note: 'the constant regions, pre-encoded at compile time',
          },
          {
            label: 'if the shell awaited its data',
            value: `${n(slow)} ms later`,
            note: 'the blocking control: a shell downstream of the query, which is the thing a slot exists to prevent',
            state: 'over',
          },
        ],
        {
          what: `A fragment that reads something slow becomes a hole by construction, so the shell is never downstream of the query. The cuts below are real: they were computed by running the same function the kernel runs, on the shell of the page you are reading.`,
          from: 'splitAtSlots() in @weft/kernel, over the real compiled shell',
          caveat:
            'These are byte offsets, not timings. Loopback has no network in it, so a first-byte number measured here would be a number about this machine. The dashboard is where the latency is real.',
          tryThis:
            'Open the dashboard with the slider set high. The chrome and the fast panels arrive; the slow one lands last.',
        },
      ),
  }
}

export const streamingOrder: StationHandler = async (ctx) => {
  const order = ctx.query('order') === 'in-order' ? 'in-order' : 'out-of-order'
  const slow = numeric(ctx, 'slow', 900, 0, 3000)
  const fast = numeric(ctx, 'fast', 120, 0, 3000)
  const medium = numeric(ctx, 'medium', 450, 0, 3000)
  const q = `slow=${slow}&fast=${fast}&medium=${medium}`

  /**
   * Two real streams, side by side. Not an animation: each frame is a live route on this server
   * with the same three latencies, served once in each order, and every region reports the
   * millisecond it was rendered at so the arrival order is still legible after the load finishes.
   */
  const race = `<div class="race-frames">
      <iframe id="race-ooo" title="out-of-order" src="/live/race?order=out-of-order&amp;${q}"></iframe>
      <iframe id="race-io" title="in-order" src="/live/race?order=in-order&amp;${q}"></iframe>
    </div>`

  const rows = [
    {
      label: 'fill mechanism',
      value: order === 'out-of-order' ? `the ${fillerSize()}-byte filler` : 'none',
      note:
        order === 'out-of-order'
          ? 'every host is closed, so content arrives elsewhere and is moved — and moving a node is JavaScript'
          : 'each slot streams where it sits, so there is nothing to move and nothing to load',
      state: order === 'out-of-order' ? ('over' as const) : ('within' as const),
    },
    {
      label: 'a slow slot',
      value: order === 'out-of-order' ? 'delays only itself' : 'delays every slot after it',
      note:
        order === 'out-of-order'
          ? 'fastest-first: the pipe is filled with whatever is ready'
          : 'document order is the delivery order, which is what makes it free',
      state: order === 'out-of-order' ? ('within' as const) : ('over' as const),
    },
    {
      label: 'works with no JavaScript',
      value: order === 'in-order' ? 'yes' : 'no',
      note:
        order === 'in-order'
          ? 'nothing has to move, so nothing has to run'
          : 'the filler is the price of fastest-first, not a fallback for weaker engines',
      state: order === 'in-order' ? ('within' as const) : ('over' as const),
    },
    {
      label: 'chosen how',
      value: 'derived',
      note: 'out-of-order the moment any slot asks to stream, in-order when none does — because in-order needs no fill mechanism, so the cheaper choice is the derived one rather than the default one',
      state: 'plain' as const,
    },
  ]

  return {
    panel: panel(
      [
        field('slow lane (ms)', slider('race-slow', 0, 3000, slow, 50)),
        field('fast lane (ms)', slider('race-fast', 0, 3000, fast, 50)),
        field('medium lane (ms)', slider('race-medium', 0, 3000, medium, 50)),
        press('race-run', 'run both again'),
        field('the readout describes', pick('order-order', ['out-of-order', 'in-order'], order)),
        press('order-go', 'switch'),
      ].join(''),
      'Press “run both again”. The left frame fills fastest-first; the right one fills top to bottom, so its fast lane waits behind the slow lane above it.',
    ),
    body: async () =>
      race +
      (await readout(`${order}`, rows, {
        what: `Two live streams of the same three regions, one in each order. The left frame sent its shell with an anchor at each slot and then filled whichever region resolved first; the right frame streamed each region where it sits, so its fast lane could not arrive until the slow lane above it had. Each region prints the millisecond it was rendered at, so the difference survives the page finishing.`,
        from: 'streamRoute() in @weft/kernel serving /live/race, twice, with the latencies above',
        caveat:
          'Loopback has no network in it, so these numbers are server-side waiting only. On a real link out-of-order also wins on the bytes that arrive first, which the streaming station is about.',
        tryThis:
          'Set the fast lane to 0 and the slow lane to 3000, then run both. On the left the fast lane lands immediately; on the right it lands after three seconds, having waited for a region it does not depend on.',
      })),
  }
}

export const blockingControl: StationHandler = async (ctx) => {
  const slow = numeric(ctx, 'slow', 400, 0, 2000)
  const started = Date.now()
  await new Promise((resolve) => setTimeout(resolve, slow))
  const waited = Date.now() - started
  return {
    panel: panel(
      [
        field('the loader takes (ms)', slider('block-slow', 0, 2000, slow, 50)),
        press('block-go', 'reload'),
      ].join(''),
      'This page really did await before sending anything. The number below is how long you waited for the chrome.',
    ),
    body: async () =>
      readout(
        'A shell downstream of its query',
        [
          {
            label: 'awaited before rendering',
            value: `${waited} ms`,
            note: 'you saw nothing at all for this long',
            state: 'over',
          },
          {
            label: 'the streaming version',
            value: 'chrome immediately',
            note: 'the same data, behind a slot, arrives when it arrives',
            state: 'within',
          },
          {
            label: 'why frameworks do this',
            value: 'one await is simpler',
            note: 'and it is invisible on a fast connection with a warm database, which is where it is usually measured',
          },
        ],
        {
          what: `The contrast station. This handler awaits its data before returning anything, so the whole page — including the navigation and the stylesheet link — waits for it. Every other page on this site sends its chrome first.`,
          from: 'a real await in this handler, timed on this request',
          caveat:
            'Loopback has no network, so this understates the difference: on a slow link the blocked version also delays the stylesheet and the module preload, which the early-hints station is about.',
          tryThis: 'Set it to 2000 ms and reload. Then open the dashboard with the same figure.',
        },
      ),
  }
}

// ── epochs ───────────────────────────────────────────────────────────────────────────

export const epochs: StationHandler = async (ctx) => {
  const commit = ctx.query('commit') === 'yes'
  const compiled = await compileDemo()
  const feed = compiled.feed
  const binding = listBinding(feed)
  const epochs_ = createEpochs()

  const staged: Frame[] = [
    frame(
      'DELTA',
      { s: 'feed', tpl: feed.entry.version, base: 'b1', next: 'b2' },
      new TextEncoder().encode('{"count":121}'),
      true,
    ),
    frame(
      'DELTA',
      { s: 'prices', tpl: feed.entry.version, base: 'b1', next: 'b2' },
      new TextEncoder().encode('{"price":9100}'),
      true,
    ),
  ]
  epochs_.stage('e-1', 'feed', staged[0] as Frame)
  epochs_.stage('e-1', 'prices', staged[1] as Frame)
  const before = epochs_.slots('e-1')
  const emitted = commit ? epochs_.commit('e-1', 'view') : []

  const preview = new TextDecoder()
    .decode(
      render(
        feed.entry,
        { heading: 'Markets', count: 3, generated: 0, [binding]: feedItems(3, 0) } as unknown as Values,
        feed.resolve,
      ),
    )
    .slice(0, 220)

  return {
    panel: panel(
      [
        field('commit', pick('epoch-commit', ['no', 'yes'], commit ? 'yes' : 'no')),
        press('epoch-go', 'apply'),
        '<label>a half-typed form<input id="epoch-form" placeholder="type here, then commit"></label>',
      ].join(''),
      'Type into the box, then commit. Whether it survives is the whole point of separating data currency from view currency.',
    ),
    body: async () =>
      readout(
        commit ? 'Committed' : 'Staged, and painting nothing',
        [
          {
            label: 'staged slots',
            value: before.join(', ') || 'none',
            note: 'fully fetched, fully resolved, and invisible',
          },
          {
            label: 'frames sent',
            value: String(emitted.length),
            note: commit
              ? emitted.map((f) => f.kind).join(' → ') + ' — one COMMIT flips every slot in the epoch at once'
              : 'nothing. A staged frame carries an epoch header, and the client puts it in staging rather than in the DOM',
            state: commit ? 'within' : 'plain',
          },
          {
            label: 'still open',
            value: String(epochs_.open.length),
            note: commit
              ? 'the epoch was consumed by the commit'
              : 'waiting. Prefetch cannot disturb the present',
          },
          {
            label: 'rollback',
            value: 'discard the epoch',
            note: 'nothing painted, so there is nothing to un-paint, and no prior state to reconstruct',
            state: 'within',
          },
        ],
        {
          what: `An epoch is data that has arrived and resolved and is painting nothing. Any number of them coexist with what is live, and one COMMIT flips every slot staged in one of them together — so the page never shows a half-updated state, a background revalidation can sit staged through a half-typed form, and an optimistic update is a staged epoch committed immediately.`,
          from: 'createEpochs() in @weft/kernel, staged and committed on this request',
          caveat:
            'This is the server half. The client half is in @weft/client and is where the paint actually happens — the intents station drives both ends over a real channel.',
          tryThis:
            'Type in the box, set commit to yes, and press apply. The commit is a page load here, so the box clears — over a channel it would not, which is the difference the cart showcase demonstrates.',
        },
      ),
    readout: pre(preview),
  }
}

// ── components ───────────────────────────────────────────────────────────────────────

export const components: StationHandler = async () => {
  const compiled = await compileDemo()
  const ordinary = compiled.ordinary
  const instances = ordinary.entry.holes.filter((h) => h.kind === 'component')
  const nested = new Set(instances.map((h) => h.nested).filter(Boolean))

  return {
    panel: panel(
      '',
      'Three instances on the ordinary showcase, from one imported component. Both files are in demo/src/fragments.',
    ),
    body: async () =>
      readout(
        'ordinary.tsx, which renders product-card.tsx three times',
        [
          {
            label: 'component holes',
            value: String(instances.length),
            note: instances.map((h) => h.binding).join(', '),
          },
          {
            label: 'sealed templates',
            value: String(nested.size),
            note: 'one, whatever the instance count. This is the number that does not grow',
            state: 'within',
          },
          {
            label: 'props projected',
            value: String(instances.reduce((sum, h) => sum + Object.keys(h.props ?? {}).length, 0)),
            note: 'each instance maps child prop names to the parent bindings that supply them',
          },
          {
            label: 'isolated instances',
            value: String(instances.filter((h) => h.isolated).length),
            note: 'a child the compiler cut out because it is private and its caller is not. None here: the card reads nothing',
          },
          {
            label: 'a component inside a list row',
            value: 'E_COMPONENT_IN_LIST',
            note: 'not supported yet, which is why the three cards are written out rather than mapped. It is on the roadmap',
            state: 'over',
          },
        ],
        {
          what: `Composition, counted. A component is sealed once and projected many times: the parent template carries a component hole per instance, each with a prop map, and nothing is inlined — so page weight tracks content rather than tracking how many components the page uses.`,
          from: 'the real component holes of ordinary.tsx, from compileFiles()',
          caveat:
            'Two limitations are real and named: children inside a component are E_COMPONENT_CHILDREN_UNSUPPORTED, and a component inside a list row is E_COMPONENT_IN_LIST. Both are on the roadmap rather than worked around here.',
          tryThis:
            'Open /app/ordinary/pantry, then /app/ordinary/household. Different content, same two templates.',
        },
      ),
    readout: pre(compiled['product-card']?.source ?? ''),
  }
}
