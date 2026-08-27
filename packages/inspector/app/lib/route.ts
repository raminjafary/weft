import { defineRoute, type RenderContext, type RouteModule } from '@weftjs/core'
import { BY_ID } from './stations.ts'
import { HANDLERS } from './stations/index.ts'
import type { PageParts, SlotContent } from './pages.ts'

/**
 * A station, as a route.
 *
 * Every station page is the same shape — a control panel, a body, and a readout of what was
 * measured — so it is the same declaration with a different handler. Fifty files that each say
 * `stationRoute('waves')` is not boilerplate worth removing: the file is what puts the station on
 * `/s/waves`, and a registry that mapped ids to handlers behind the router's back is exactly the
 * indirection the convention exists to delete.
 *
 * The handler runs once per request even though three slots read from it. It measures things, and
 * a station that measured its own subject three times would be reporting a number nobody asked
 * for.
 *
 * The body and the readout are live, so pressing a station's "go" button asks the server for
 * those two regions and patches them. It used to navigate — which threw the document away and
 * built another one to show you a number that had changed, and lost the sliders you were holding
 * on the way.
 */
const inflight = new WeakMap<object, Promise<PageParts>>()

function parts(id: string, ctx: RenderContext): Promise<PageParts> {
  const key = ctx as unknown as object
  const existing = inflight.get(key)
  if (existing) return existing
  const handler = HANDLERS[id]
  if (!handler) throw new Error(`E_NO_HANDLER: station '${id}' has no handler`)
  const promise = handler(ctx)
  inflight.set(key, promise)
  return promise
}

async function part(id: string, ctx: RenderContext, which: keyof PageParts): Promise<string> {
  const content: SlotContent | undefined = (await parts(id, ctx))[which]
  if (content === undefined) return ''
  return typeof content === 'function' ? content(ctx) : content
}

/**
 * A capability that does not exist is refused with a name rather than approximated, and a page
 * that is not written yet says so. Both come from the registry, which is what the index reads —
 * so neither can quietly claim to be live.
 */
function notBuilt(id: string): string {
  const station = BY_ID[id]
  const refused = station?.status === 'refused'
  return `<div class="card"><h3>${refused ? 'Not built' : 'Page not written yet'}</h3>
    <p>${
      refused
        ? 'The capability does not exist. Rather than mock it, this page says so.'
        : 'The capability is built and measured; this page is not written yet. It is marked <code>planned</code> in the registry, and the registry is what the index reads.'
    }</p>
    <p class="hint">Covers ${station?.covers.map((c) => `<code>spec/${c}</code>`).join(', ')}</p></div>`
}

export function stationRoute(id: string): RouteModule {
  const station = BY_ID[id]
  if (!station) throw new Error(`E_NO_STATION: ${id}`)
  const handler = HANDLERS[id]
  /**
   * Whether this station's regions may be refreshed from the server.
   *
   * The client stations hold state the server does not have: a signal's current value is the
   * browser's, and the quantity you just typed exists nowhere else. Re-rendering such a region
   * from the server overwrites it with the fixture's value — so the page appears to ignore your
   * input, which is the opposite of what those stations are demonstrating.
   *
   * Every other station's regions are a function of the request, so they are refreshable and
   * their controls patch instead of navigating.
   */
  const refreshable = station.group !== 'client'

  return defineRoute({
    head: { title: `${station.title} · weft demo`, description: station.shows },
    // The four values the demo's layout reads beyond the framework's own. Declaring them is what
    // lets the layout have those holes at all: one it nobody supplied would fail the build.
    layoutValues: {
      heading: station.title,
      shows: station.shows,
      control: station.control,
      status: station.status,
    },
    slots: {
      /**
       * The panel is sent first, buffered, and deliberately *not* live.
       *
       * A control you cannot touch until the measurement lands is not a control, which is why it
       * is first. And a panel that refreshed itself would re-render the sliders you are holding —
       * losing their position and the focus — to show you the values you just typed. The two
       * regions that change when a control changes are the body and the readout, and those are
       * the two that are live.
       */
      panel: { fragment: 'markup', stream: false, html: (ctx) => part(id, ctx, 'panel') },
      body: handler
        ? { fragment: 'markup', stream: false, live: refreshable, html: (ctx) => part(id, ctx, 'body') }
        : { fragment: 'markup', stream: false, html: notBuilt(id) },
      readout: {
        fragment: 'markup',
        stream: false,
        live: refreshable,
        html: (ctx) => part(id, ctx, 'readout'),
      },
    },
  })
}
