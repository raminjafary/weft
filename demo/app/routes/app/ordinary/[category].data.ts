import { defineRoute } from '@weftjs/core'
import { panel } from '../../../lib/controls.ts'
import { CATEGORIES, type Item } from '../../../lib/catalogue.ts'
import { cartOf } from '../../../lib/data.ts'

/** Three instances, flattened into one value set: a component inside a list row is `E_COMPONENT_IN_LIST` today. */
const flat = (prefix: string, item: Item): Record<string, string | number | boolean> => {
  // The demo's shared cart, deliberately — a per-visitor count here would leak between visitors, since
  // this slot is `public` and the loader (a .ts file) is invisible to the compiler's read tracking.
  const held = cartOf('demo-shared').get(item.sku) ?? 0
  return {
    [`${prefix}Sku`]: item.sku,
    [`${prefix}Name`]: item.name,
    [`${prefix}Price`]: item.price,
    [`${prefix}Unit`]: item.unit,
    [`${prefix}Badge`]: item.badge,
    [`${prefix}Available`]: item.available,
    [`${prefix}Cart`]: held ? `${held} in the shared cart` : '',
  }
}

/** An ordinary page. No streaming, no channel, no deltas — every slot buffers, so the plan derives `in-order` with no fill mechanism. */
export default defineRoute({
  head: (params) => ({ title: `${params.category ?? 'pantry'} — an ordinary page · weft demo` }),
  layoutValues: {
    heading: 'An ordinary page',
    shows:
      'No streaming, no channel, no deltas. One route, one component rendered three times, and a page that arrives in one piece.',
    control:
      'Add one to the cart. It is a form post to the same intent the cart page dispatches over a socket, so it works with JavaScript turned off — and switching category changes the content without changing the template.',
    status: 'live',
  },
  /** Only possible because every slot on the page buffers — a streaming page declaring this is `E_ETAG_STREAMS`. See `spec/kernel/cache.md`. */
  etag: true,
  /** The two categories this page has. Nothing is inferred: L0 needs an explicit list to render each one as a file. */
  params: { category: ['pantry', 'household'] },
  /** What the response advertises, distinct from what the store holds. Without it the document is `no-store`. */
  document: { class: 'public', ttl: '10m' },
  slots: {
    /** Two ordinary links: same route, same layout, different param. Hover stages, click swaps the DOM. Plain `<a href>`, nothing opts in. */
    panel: {
      fragment: 'markup',
      stream: false,
      html: (_ctx, params) => {
        const current = params.category === 'household' ? 'household' : 'pantry'
        const pill = (key: string, label: string): string =>
          `<a class="pill" href="/app/ordinary/${key}"${
            key === current ? ' aria-current="page"' : ''
          }>${label}</a>`
        return panel(
          [pill('pantry', 'pantry'), pill('household', 'household')].join(''),
          'Hover one, then click it: the document was already here, so the click paints rather than loads. ' +
            'Click without hovering first and it is an ordinary navigation — the counter below says which of your clicks was which.',
        )
      },
    },
    body: {
      fragment: 'ordinary',
      stream: false,
      /**
       * What this page may download: the whole application's client, since there is no bundler here.
       * `grow` catches drift a fixed ceiling wouldn't. Moved from 48kb to 52kb when the runtime added
       * `weft:navigated` (116 bytes) — the event any app's own client.ts needs to know a staged
       * navigation replaced the markup it wired itself to. See `spec/plan/plan.md` and `spec/client/navigation.md`.
       */
      budget: { js: '52kb', grow: '2kb' },
      // Tagged, since the cart counts are in these bytes and cart.add declares it writes `cart`.
      cache: { class: 'public', ttl: '10m', tags: ['cart'] },
      /** Re-rendered after the response that needed it, not during it — one render pays for the next ten minutes. */
      speculate: true,
      load: (_ctx, params) => {
        const key = params.category === 'household' ? 'household' : 'pantry'
        const category = CATEGORIES[key] as (typeof CATEGORIES)[string]
        const [a, b, c] = category.items as [Item, Item, Item]
        return {
          category: key === 'household' ? 'Household' : 'Pantry',
          intro: category.intro,
          ...flat('first', a),
          ...flat('second', b),
          ...flat('third', c),
        }
      },
    },
    readout: {
      fragment: 'markup',
      stream: false,
      html: `<div class="card"><h3>What this page cost</h3>
        <dl class="prov">
          <dt>Sealed templates</dt><dd>2 — the page and the card, whatever the card count</dd>
          <dt>Component instances</dt><dd>3, projected into the card's holes rather than mounted</dd>
          <dt>Streaming order</dt><dd><code>in-order</code>, derived: no slot asked to stream</dd>
          <dt>Fill mechanism</dt><dd>none, so the out-of-order filler is not on the wire</dd>
          <dt>Cache class</dt><dd><code>public</code> — this fragment reads nothing but its route param</dd>
          <dt>Conditional</dt><dd>a strong <code>ETag</code>: a return visit is a 304 and no body</dd>
          <dt>Writes</dt><dd>a form post to <code>/_weft/i/cart.add</code>, answered with a 303 back here</dd>
          <dt>JavaScript needed</dt><dd>none. Turn it off and the button still works</dd>
          <dt>Switching category</dt><dd>staged on hover, committed on click — <span data-weft-stat="nav" class="mono">no navigations yet</span></dd>
          <dt>Held, unpainted</dt><dd><span data-weft-stat="staged" class="mono">nothing staged</span></dd>
        </dl></div>`,
    },
  },
})
