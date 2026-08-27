import { defineRoute } from 'weft'
import { panel } from '../../../lib/controls.ts'
import { CATEGORIES, type Item } from '../../../lib/catalogue.ts'
import { cartOf } from '../../../lib/data.ts'

/**
 * Three instances, flattened into one value set.
 *
 * `ordinary.tsx` writes its three cards out rather than mapping them, because a component inside a
 * list row is `E_COMPONENT_IN_LIST` today — so its props are named `firstName`, `secondName` and so
 * on, and this is the one place that shape is spelled.
 */
const flat = (prefix: string, item: Item): Record<string, string | number | boolean> => {
  // The demo's shared cart, deliberately, and not the one belonging to whoever is asking. This
  // slot is a `public` entry: a per-visitor count in it would be one visitor's cart served to the
  // next from the store, and nothing in the read set would have said so — the loader is a `.ts`
  // file and the compiler never sees it. The cart page is where a private region is demonstrated.
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

/**
 * An ordinary page. No streaming, no channel, no deltas.
 *
 * Every slot buffers, so the plan the framework generated lowers to `in-order` — and in-order
 * needs no fill mechanism, so the out-of-order filler is not on the wire. Nothing chose that; it
 * was derived from the fact that no slot asked to stream.
 */
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
  /**
   * The page answers a conditional request, which it can only do because every slot on it buffers.
   *
   * A digest has to be over the whole entity and the envelope is sealed before the first byte, so a
   * page that streams cannot carry one — this page gave up arrival order already, and what it buys
   * back is a return visit that costs a 304 and no body at all. Declaring this on a streaming page
   * is `E_ETAG_STREAMS` rather than a page that quietly stopped streaming.
   */
  etag: true,
  /**
   * The two categories this page has, which is what makes a parameterised page a file.
   *
   * L0 refuses a pattern with a parameter because there is no single URL a file could answer. This
   * route has two, and the build renders each one, proves each one invariant on its own, and writes
   * both — so `weft start` answers them before the kernel is reached. Nothing infers this list: it
   * is the application's knowledge, and a framework guessing at it would write files for URLs
   * nobody asked for.
   */
  params: { category: ['pantry', 'household'] },
  /**
   * What the response itself advertises, which is a different question from what the store holds.
   * Without it the document is `no-store` — nothing is cached by accident here — and a validator on
   * a response the reader was told not to keep is a validator for nobody.
   */
  document: { class: 'public', ttl: '10m' },
  slots: {
    /**
     * Two ordinary links, and the pair is the whole demonstration.
     *
     * Same route, same layout, same sealed templates, different param — so what changes between
     * them is content and nothing else. Hover one and the framework fetches the page and holds it,
     * painting nothing; click it and the click is a DOM swap rather than a request, so there is no
     * blank frame, nothing above the content is rebuilt, and the templates the browser already
     * holds are not sent again.
     *
     * They are `<a href>` and nothing more. Nothing here opts in, and with JavaScript off they are
     * two links to two URLs — which is the floor the whole framework is built on rather than a
     * fallback bolted to the side of it.
     */
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
       * What this page may download, and how far it may drift.
       *
       * There is no bundler here, so this is the whole application's client rather than this
       * slot's share of it — the build says so when it refuses. The ceiling is above where the
       * demo sits today on purpose: a budget set to the current number is a budget that fails on
       * the next honest comment, and `grow` is the half that notices drift anyway.
       *
       * It moved from 48kb when the runtime started announcing a navigation. `weft:navigated` is
       * 116 bytes and it is the only way an application's own `client.ts` can know that a staged
       * navigation replaced the markup it wired itself to — every application that ships a client
       * module and a router needs it, so the framework pays for it rather than each of them
       * re-deriving it from `popstate` and a MutationObserver.
       */
      budget: { js: '52kb', grow: '2kb' },
      // Tagged, because the cart counts are in these bytes and `cart.add` declares that it writes
      // `cart`. Without the tag the page would keep showing the count from before your click for
      // ten minutes, which is a cache doing exactly what it was told and exactly the wrong thing.
      cache: { class: 'public', ttl: '10m', tags: ['cart'] },
      /**
       * And re-rendered after somebody's response rather than during it.
       *
       * A ten-minute TTL means one request every ten minutes pays for a render, and it is always
       * a reader's. This moves it to the end of a response that has already been sent.
       */
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
