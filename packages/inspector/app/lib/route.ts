import { defineRoute, type RenderContext, type RouteModule } from '@weftjs/core'
import { BY_ID } from './stations.ts'
import { HANDLERS } from './stations/index.ts'
import type { PageParts, SlotContent } from './pages.ts'

/**
 * A station, as a route: the same shape (panel, body, readout) with a different handler each
 * time. The handler runs once per request and is cached across the three slots that read it, so a
 * station doesn't measure its own subject three times. Body and readout are live, so a station's
 * "go" button patches instead of navigating — which used to lose the sliders you were holding.
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

/** A capability that doesn't exist is refused by name; a page not written yet says so. Both come from the registry the index reads. */
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
  // A client station holds state the server doesn't have (e.g. a signal's live value); refreshing it from the server would overwrite what you just typed.
  const refreshable = station.group !== 'client'

  return defineRoute({
    head: { title: `${station.title} · weft demo`, description: station.shows },
    // The four values the layout reads beyond the framework's own; undeclared ones fail the build.
    layoutValues: {
      heading: station.title,
      shows: station.shows,
      control: station.control,
      status: station.status,
    },
    slots: {
      // Sent first, buffered, deliberately not live: refreshing it would re-render the sliders you're holding and lose their focus.
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
