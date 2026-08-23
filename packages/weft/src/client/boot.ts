import {
  adopt,
  computed,
  createChannelClient,
  createEpochs,
  createStaging,
  digest,
  navFrames,
  navigable,
  openResident,
  plainClick,
  signal,
  stagingKey,
  warmFrame,
  type ChannelFrame,
  type ClientTemplate,
  type Epochs,
  type LinkFacts,
  type Readable,
  type StagedNav,
  type Region,
} from '@weft/client'
import {
  createBinaryDecoder,
  encodeStream,
  frame as warpFrame,
  WARP_VERSION,
  type Frame,
  type FrameKind,
} from '@weft/warp'

/**
 * The client, for every application.
 *
 * Three jobs and no application knowledge. Adopt whatever the server said is adoptable, which
 * is a table the framework generated from the same IR it rendered from. Fire intents the markup
 * names, staged into an epoch so an optimistic guess paints nothing until the server agrees.
 * And, on a page that has a live region, hold a channel open and hand arriving frames to the
 * runtime's own frame router.
 *
 * There is no framework-specific protocol in here. Frames are encoded by the real codec and
 * routed by the real client runtime; this file is wiring, and if it grew a second encoder it
 * would be a file that disagrees with the protocol the first time the protocol moves.
 */
interface AdoptPayload {
  slot: string
  selector: string
  template: ClientTemplate
  /** Row and component templates the region's holes name. Without them a row adopts nothing. */
  templates?: ClientTemplate[]
  base: string
  signals?: { id: string; init: unknown }[]
  values?: Record<string, unknown>
  intents?: Record<string, string>
  live?: boolean
}

interface WeftState {
  regions: number
  writes: number
  connected: boolean
  /** How far boot got. A silent failure in an async boot looks exactly like a page with no script. */
  stage: string
  /**
   * When this page became interactive, on its own clock — so on a fresh document it is the whole
   * cost of arriving, navigation included, and the number a staged navigation is compared against.
   */
  readyAt: number
  frames: { dir: 'up' | 'down'; text: string }[]
  /** Slots on this page the server will refresh over the channel. Empty means there is nothing to ask for. */
  live: string[]
  /**
   * Ask the server for these slots again, optionally from a different URL.
   *
   * This is what a control on a page with a live region should do instead of navigating. A
   * navigation throws the document away and builds another one; this sends one frame and gets
   * back a delta — one DOM write per value that actually changed, and the scroll position, the
   * focus and every other region left alone.
   *
   * `at` re-registers where the client is, because the server resolves a refresh by matching that
   * path against the same route table the document went through. Without it a control could
   * change what it asks for but not what the answer is computed from.
   */
  refresh(slots?: readonly string[], at?: string): Promise<number>
  /** Routes fetched and unpainted, by URL. Staging one cannot disturb the page they are staged from. */
  staged: string[]
  /**
   * Navigations from this page, by what the click cost. `staged` was answered here from a route
   * that was already fetched; `cold` was handed back to the browser, which is what a link has
   * always cost. There is deliberately no third case — see `go`.
   */
  nav: { staged: number; cold: number; lastMs: number }
  /**
   * Go somewhere, the way a click on a link would. False when it fell back to a real navigation.
   *
   * `scroll` defaults to the application's `navigation.scroll`, which defaults to `top`.
   */
  navigate(href: string, scroll?: 'top' | 'preserve'): Promise<boolean>
}

declare global {
  interface Window {
    weft?: WeftState
    /** Set by the served prelude: the framework knows these, the file cannot derive them. */
    __weftIntents?: Record<string, string>
    __weftChannel?: string
    __weftClient?: string
    /** What a route change does to the scroll position: the config's `navigation.scroll`. */
    __weftScroll?: 'top' | 'preserve'
  }
}

const state: WeftState = {
  regions: 0,
  writes: 0,
  connected: false,
  stage: 'loaded',
  readyAt: 0,
  frames: [],
  live: [],
  refresh: (slots, at) => refresh(slots, at),
  staged: [],
  nav: { staged: 0, cold: 0, lastMs: 0 },
  navigate: (href, scroll) => navigate(href, scroll),
}
/** True once a region declares itself refreshable, which is what decides whether to connect. */
let liveRegions = false
window.weft = state

function log(dir: 'up' | 'down', text: string): void {
  state.frames.push({ dir, text })
  while (state.frames.length > 200) state.frames.shift()
  const box = document.querySelector('[data-weft-log]')
  if (!box) return
  const line = document.createElement('div')
  line.dataset.dir = dir
  line.textContent = `${dir === 'up' ? '↑' : '↓'} ${text}`
  box.prepend(line)
  while (box.childElementCount > 60) box.lastElementChild?.remove()
}

function describe(frame: ChannelFrame): string {
  const header = Object.entries(frame.header)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ')
  return `${frame.kind} ${header}${frame.body ? ` (${frame.body.length} B)` : ''}`
}

function payloads<T>(id: string, within: ParentNode = document): T[] {
  const out: T[] = []
  for (const node of within.querySelectorAll(`script[type="application/json"][data-weft="${id}"]`)) {
    if (!node.textContent) continue
    out.push(JSON.parse(node.textContent) as T)
  }
  return out
}

// ── adoption ─────────────────────────────────────────────────────────────────────────

const writable = new Map<string, ReturnType<typeof signal<unknown>>>()
/** Which signal an intent should write, by the intent id the wiring named. */
const intentTargets = new Map<string, string>()

/**
 * `adopt` binds nodes to signals; it does not invent them. A signal's current value is
 * application state rather than template structure, so the framework creates them from the
 * declarations the server shipped. Props a client-owned derived value reads arrive the same
 * way, and only those props: `qty * unitPrice` is recomputed in the browser, so the browser
 * is sent `unitPrice` and nothing else out of the value set.
 */
async function adoptRegions(within?: Element): Promise<Region[]> {
  const entries = payloads<AdoptPayload>('adopt', within).flat()
  if (!entries.length) return []
  const store = await openResident()
  const resident = await store.all()
  const regions: Region[] = []

  for (const entry of entries) {
    const root = document.querySelector(entry.selector)
    if (!root) continue
    for (const template of [entry.template, ...(entry.templates ?? [])]) {
      resident[template.version] = template
      await store.put(template)
    }

    const signals: Record<string, Readable<unknown>> = {}
    for (const declaration of entry.signals ?? []) {
      const source = signal<unknown>(declaration.init)
      writable.set(declaration.id, source)
      signals[declaration.id] = source
    }
    // A constant readable. A prop is not reactive, but a derived value that reads one still
    // has to be able to read it: a derived value is only built when every reference is bound.
    for (const [id, value] of Object.entries(entry.values ?? {})) {
      signals[id] = computed(() => value)
    }

    const first = entry.signals?.[0]?.id
    for (const id of Object.keys(entry.intents ?? {})) {
      if (first) intentTargets.set(id, first)
    }

    const adopted = adopt({
      root,
      template: entry.template,
      resident,
      signals,
      onIntent: (intent, event) => {
        const target = event.target as HTMLElement | null
        if (!target) return
        // The local half of an optimistic write, when there is a signal to write: the control
        // that fired updates it now, and the server's answer arrives in an epoch that paints
        // over it or rolls it back. A region with no signal has nothing to guess with, and its
        // truth comes back as a delta — which for a cart total is the only version worth having.
        const binding = intentTargets.get(intent)
        if (binding) {
          const next = Number((target as HTMLInputElement).value)
          if (Number.isFinite(next)) writable.get(binding)?.set(next)
        }
        void send([intentFrame(intent, payloadOf(target))])
      },
    })
    if (entry.live) {
      liveRegions = true
      state.live.push(entry.slot)
    }
    regions.push({ slot: entry.slot, adopted, base: entry.base })
  }

  document.cookie = `weft-resident=${digest(Object.keys(resident))}; path=/; max-age=600; SameSite=Lax`
  return regions
}

// ── intents ──────────────────────────────────────────────────────────────────────────

/**
 * The map from the name an author wrote in their markup to the opaque id that goes on the wire.
 *
 * The wire carries six hex characters, which is the design's rule and the reason renaming a
 * server export is not a client change. The map arrives in the boot module's own prelude rather
 * than in the page, so a document's bytes carry no server names at all — and the module is
 * immutable, so it is fetched once.
 */
let intentIds: Record<string, string> = {}

function intentFrame(id: string, input: unknown): ChannelFrame {
  return {
    kind: 'INTENT',
    header: { i: id, e: `o-${Date.now().toString(36)}` },
    body: new TextEncoder().encode(JSON.stringify(input)),
  }
}

/**
 * What an intent is sent, when the markup has not spelled it out.
 *
 * An explicit `data-weft-payload` wins. Failing that: a form's fields, because a form already
 * says what it is submitting. Failing that, the control's own `name` and value plus the data
 * attributes of the nearest ancestor carrying any — which is how a row identifies itself. A
 * quantity box inside `<tr data-sku="RICE-5K">` sends `{ sku: 'RICE-5K', qty: '3' }`, and nothing
 * had to declare that mapping.
 *
 * `data-weft-*` attributes are the framework's own and are never sent.
 */
function payloadOf(element: HTMLElement): unknown {
  const raw = element.dataset.weftPayload
  if (raw) return JSON.parse(raw)

  // Merged, in increasing precedence, because each source knows something the others do not: the
  // row knows which record it is, the form knows what it is submitting, and the control knows what
  // you just typed. Taking only the first source that exists is how a form whose control has no
  // `name` sent an empty payload while a `data-sku` sat one element above it.
  const payload: Record<string, string> = {}
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    for (const [key, value] of Object.entries(node.dataset)) {
      if (key.startsWith('weft') || value === undefined || key in payload) continue
      payload[key] = value
    }
  }
  const form = element.closest('form')
  if (form) {
    for (const [key, value] of new FormData(form) as unknown as Iterable<[string, string]>) {
      payload[key] = value
    }
  }
  const control = element as HTMLInputElement
  if (control.name) payload[control.name] = control.value
  return payload
}

/**
 * Every element that names an intent, wired once.
 *
 * A `<form>` that names one keeps working with no JavaScript at all: the framework routes
 * `POST` to the same dispatch over plain HTTP and answers with a 303 back to the page. This
 * only upgrades it — which is the whole progressive-enhancement story, and it is one branch
 * rather than two code paths.
 */
/** Elements already bound. A region replaced as markup is wired again, and only the new nodes are. */
const wired = new WeakSet<Element>()

function wireIntents(): void {
  for (const node of document.querySelectorAll('[data-weft-intent]')) {
    if (wired.has(node)) continue
    wired.add(node)
    const element = node as HTMLElement
    const name = element.dataset.weftIntent as string
    const id = intentIds[name]
    if (!id) {
      log('up', `no such intent: ${name}`)
      continue
    }
    if (element.tagName === 'FORM') {
      element.addEventListener('submit', (event) => {
        event.preventDefault()
        void send([intentFrame(id, payloadOf(element))])
      })
      continue
    }
    element.addEventListener('click', () => {
      void send([intentFrame(id, payloadOf(element))])
    })
  }
}

// ── controls ─────────────────────────────────────────────────────────────────────────

/**
 * A control on a server-rendered page is a query parameter, and this is the whole of wiring one.
 *
 * `data-weft-control="rows"` says which parameter an input owns. `data-weft-apply` on a button
 * says "put every control's value in the URL and get the page to agree with it". Neither needs a
 * table mapping element ids to parameter names, which is what every application that did this by
 * hand ended up writing.
 *
 * How the page is made to agree depends on what the page is. With a live region it asks the server
 * for that region and patches it: one DOM write per value that changed, and the control you are
 * holding keeps its position and its focus. Without one there is nothing to ask for, so it
 * navigates — which is not a fallback, it is what such a page has always cost.
 */
function urlFromControls(): URL {
  const url = new URL(window.location.href)
  for (const node of document.querySelectorAll('[data-weft-control]')) {
    const element = node as HTMLInputElement | HTMLSelectElement
    const key = (element as HTMLElement).dataset.weftControl as string
    if (element.value === '') url.searchParams.delete(key)
    else url.searchParams.set(key, element.value)
  }
  return url
}

/**
 * Where you were, across a navigation the framework caused.
 *
 * A browser restores scroll on back and forward and on nothing else, so a control that reloads
 * with new parameters and a form that posts and gets a 303 both land you at the top of a page you
 * were halfway down. Neither is a page you asked to leave: you pressed a button *on* it.
 *
 * So the position is recorded against the path at the moment the framework navigates, and put
 * back on the way in. It is `sessionStorage` because the value is this tab's and lives exactly as
 * long as the tab does, and every access is guarded because a browser with site data blocked
 * throws on the accessor itself rather than returning nothing.
 *
 * With JavaScript off the form still posts and the scroll still resets. That is the honest floor
 * of the no-JavaScript path rather than something to hide: there is nothing on the page to record
 * it with.
 */
const SCROLL_KEY = 'weft:scroll'

/**
 * Where the reader is, recorded for a load that is about to happen somewhere else.
 *
 * The position lives against a path rather than against a history entry because the page that
 * will read it is a *new document*: nothing in this one survives to hand it over. Boot removes
 * the key it reads, so a value written here is used once and cannot be restored over a later
 * visit that arrived some other way.
 */
function handOff(path: string, y: number): void {
  try {
    sessionStorage.setItem(`${SCROLL_KEY}:${path}`, String(Math.round(y)))
  } catch {
    // A tab with site data blocked. The navigation is still correct; it starts at the top.
  }
}

function rememberScroll(): void {
  // Not the top. Recording a zero is indistinguishable from recording nothing, and it overwrites
  // a position something else deliberately handed to the load that is about to happen — which is
  // exactly what a back-triggered reload does, since the page it leaves is at the top.
  if (scrollY < 4) return
  handOff(window.location.pathname, scrollY)
}

function restoreScroll(): void {
  let held: string | null = null
  const key = `${SCROLL_KEY}:${window.location.pathname}`
  try {
    held = sessionStorage.getItem(key)
    if (held !== null) sessionStorage.removeItem(key)
  } catch {
    return
  }
  if (held === null) return
  const y = Number(held)
  if (!Number.isFinite(y) || y <= 0) return

  /**
   * Synchronously, and not a frame later.
   *
   * This module is deferred, so the document is parsed by the time it runs and the page already
   * has its height — which means this lands before the next paint. Doing it in a
   * `requestAnimationFrame` instead cost exactly one painted frame at the top of the page, and one
   * frame is precisely what a blink is.
   *
   * `instant` because a page whose CSS asks for smooth scrolling would otherwise animate the
   * restore, which is the same blink with a longer duration.
   */
  const land = (): void => window.scrollTo({ top: y, behavior: 'instant' as ScrollBehavior })
  land()
  // A slot filled out of order, a late font or an image with no dimensions can all grow or shrink
  // the document after this. Landing again once everything has loaded only helps the case where the
  // first attempt fell short, so it is skipped entirely if the reader has since scrolled themselves.
  if (document.readyState !== 'complete') {
    window.addEventListener(
      'load',
      () => {
        if (Math.abs(scrollY - y) > 4 && scrollY < 4) land()
      },
      { once: true },
    )
  }
}

/**
 * Whether this page can be brought up to date in place rather than reloaded.
 *
 * Adoption is what binds nodes to state, and the swap below replaces nodes — so what matters is
 * which *kind* of state a region declares. Wiring is fine: an intent listener is rebound against
 * the new nodes from the new payload, which is what a reload would have done anyway. Signals and a
 * live region are not: a signal holds a value nobody else has, and a live region holds the base
 * the next delta is computed against. Losing either silently is worse than a reload.
 */
function swappable(root: ParentNode): boolean {
  for (const node of root.querySelectorAll('script[type="application/json"][data-weft="adopt"]')) {
    try {
      const payload = JSON.parse(node.textContent ?? '{}') as { live?: boolean; signals?: unknown[] }
      if (payload.live || (payload.signals?.length ?? 0) > 0) return false
    } catch {
      return false
    }
  }
  return true
}

/**
 * The same page, brought up to date, without leaving it.
 *
 * A control that reloads with new parameters and a form that posts and gets a 303 are both
 * navigations the *framework* caused, and a navigation repaints from the top: the scroll position
 * is lost, and putting it back afterwards is a visible jump no matter how early it happens,
 * because a streamed document has already painted by then.
 *
 * So it is not a navigation. The answer is fetched, its regions replace this page's regions, and
 * the address bar is corrected. Nothing above `<main>` moves, nothing scrolls, and there is no
 * frame in which the page is somewhere else.
 *
 * Every failure falls back to the real navigation: a bad status, a document whose regions do not
 * match this one's, anything adopted on either side. A fallback that reloads is worse than this
 * and better than being wrong.
 */
async function swapFrom(html: string, url: string): Promise<boolean> {
  const next = parseDocument(html)
  if (!next) return false
  if (!swappable(document) || !swappable(next)) return false
  /**
   * Where the reader is, because this update is not supposed to move them anywhere.
   *
   * The holes are replaced one at a time, so for a moment the document is shorter than it was and
   * the browser clamps the scroll to fit what is left — then the content comes back and the
   * position does not. From the reader's side, pressing a button at the bottom of a page threw
   * them to the top and back.
   */
  const y = Math.round(scrollY)

  /**
   * The layout's own `<slot>` elements, not the region wrappers inside them.
   *
   * A region's adopt payload is a sibling of its wrapper and both sit inside the layout hole, so
   * cutting at the hole replaces the markup *and* the payload that describes it. Cutting one level
   * in would have left the old payload beside new nodes — a description of a render that is no
   * longer on the page, which is the kind of stale that looks like it works.
   */
  const holes = [...document.querySelectorAll('slot[name]')]
  if (!holes.length) return false
  const incoming = holes.map((hole) => next.querySelector(`slot[name="${hole.getAttribute('name') ?? ''}"]`))
  // Same page, different content — not a different page. A hole this document has and the answer
  // does not means the two are not the same shape, and swapping would leave one empty.
  if (incoming.some((node) => node === null)) return false

  holes.forEach((hole, index) => {
    hole.innerHTML = (incoming[index] as Element).innerHTML
  })
  if (next.title) document.title = next.title
  window.history.replaceState({ ...((window.history.state ?? {}) as object) }, '', url)
  here = new URL(url, window.location.href)
  regionsHeld = await adoptRegions()
  state.regions = regionsHeld.length
  wireIntents()
  wireControls()
  keepAt(y)
  return true
}

/**
 * A form that posts to an intent, upgraded when there is something to upgrade it with.
 *
 * With no JavaScript it posts, the kernel dispatches, and a 303 brings you back — which is the
 * whole progressive-enhancement story and the reason the markup is a form in the first place.
 * With JavaScript the same post is a `fetch`, the redirect it follows is the page it came from,
 * and that answer is swapped in place: same write, same server code, no navigation.
 *
 * Captured at the document rather than wired per form, because a region replaced by a delta
 * brings new forms with it and a listener re-attached per region is a listener that will be
 * missed once.
 */
function upgradeIntentForms(): void {
  document.addEventListener(
    'submit',
    (event) => {
      const form = event.target as HTMLFormElement | null
      if (!form?.action.includes('/_weft/i/')) return
      if (!swappable(document)) {
        // An adopted page keeps its own paths — the wiring the compiler emitted sends this over
        // the channel. Record the position for the plain post that is about to happen.
        rememberScroll()
        return
      }
      event.preventDefault()
      void (async () => {
        const body = new URLSearchParams(new FormData(form) as unknown as Record<string, string>).toString()
        const response = await fetch(form.action, {
          method: 'POST',
          body,
          headers: { accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
        }).catch(() => null)
        if (response?.ok && (await swapFrom(await response.text(), response.url))) return
        rememberScroll()
        form.submit()
      })()
    },
    true,
  )
}

async function apply(): Promise<void> {
  const url = urlFromControls()
  if (!state.live.length) {
    const target = url.toString()
    const response = await fetch(target, { headers: { accept: 'text/html' } }).catch(() => null)
    if (response?.ok && (await swapFrom(await response.text(), target))) return
    rememberScroll()
    window.location.assign(target)
    return
  }
  // The address bar has to agree with what the server was asked, or a reload shows something else.
  window.history.replaceState(null, '', url.toString())
  await refresh(undefined, url.pathname + url.search)
}

function wireControls(): void {
  for (const node of document.querySelectorAll('[data-weft-apply]')) {
    if (wired.has(node)) continue
    wired.add(node)
    node.addEventListener('click', () => void apply())
  }
  // A range input whose value is invisible is a mystery until you let go of it. This needs no
  // application knowledge, so it is not the application's to write.
  for (const node of document.querySelectorAll('input[type=range][data-weft-control]')) {
    const input = node as HTMLInputElement
    const label = input.closest('label')
    if (!label || label.querySelector('[data-weft-readout]')) continue
    wired.add(input)
    const out = document.createElement('span')
    out.dataset.weftReadout = ''
    out.className = 'mono'
    out.textContent = ` ${input.value}`
    label.append(out)
    input.addEventListener('input', () => {
      out.textContent = ` ${input.value}`
    })
  }
}

// ── what the runtime is doing ────────────────────────────────────────────────────────

/**
 * The framework's own state, painted into whatever asks for it.
 *
 * `data-weft-stat="writes"` and friends are here because every page that wanted to show these
 * numbers was writing the same polling loop against `window.weft` — which is glue over the
 * framework's internals, in the application, kept in step by hand. The state belongs to the
 * runtime, so describing it does too.
 *
 * `state` is the connection, `writes` the DOM writes deltas have performed, `regions` how many
 * adopted regions this page holds, `stage` how far boot got, and `resident` what the template
 * store is holding — the last of which only the client can answer, because it is in IndexedDB.
 */
async function describeResident(): Promise<string> {
  try {
    const store = await openResident()
    const all = await store.all()
    const count = Object.keys(all).length
    return `${count} template${count === 1 ? '' : 's'} · ${store.durable ? 'IndexedDB' : 'memory only'}`
  } catch (error) {
    return `unavailable: ${String(error)}`
  }
}

function paintStats(): void {
  for (const node of document.querySelectorAll('[data-weft-stat]')) {
    const element = node as HTMLElement
    switch (element.dataset.weftStat) {
      case 'state':
        element.textContent = state.connected ? `open · ${state.regions} region(s)` : state.stage
        break
      case 'writes':
        element.textContent = `${state.writes} DOM writes`
        break
      case 'regions':
        element.textContent = String(state.regions)
        break
      case 'stage':
        element.textContent = state.stage
        break
      case 'boot':
        element.textContent = state.readyAt ? `${state.readyAt}ms to interactive` : state.stage
        break
      case 'staged':
        element.textContent = state.staged.length
          ? state.staged.map((url) => new URL(url).pathname).join(' · ')
          : 'nothing staged'
        break
      case 'nav':
        element.textContent = `${state.nav.staged} staged · ${state.nav.cold} cold${
          state.nav.lastMs ? ` · last ${state.nav.lastMs}ms` : ''
        }`
        break
      default:
        break
    }
  }
}

/** The poll is started once per page load, not once per swap: a second one paints the same nodes. */
let polling = false

async function wireRuntimeReadouts(): Promise<void> {
  const stats = document.querySelectorAll('[data-weft-stat]')
  const resident = document.querySelectorAll('[data-weft-resident]')
  const forget = document.querySelectorAll('[data-weft-forget]')
  if (stats.length) {
    paintStats()
    // Polled rather than pushed: a delta arriving is not an event the application asked for, and
    // a subscription nobody unsubscribes from outlives the element it was painting.
    if (!polling) {
      polling = true
      window.setInterval(paintStats, 500)
    }
  }
  for (const node of resident) node.textContent = await describeResident()
  for (const node of forget) {
    node.addEventListener('click', () => {
      indexedDB.deleteDatabase('weft')
      document.cookie = 'weft-resident=; path=/; max-age=0'
      for (const target of document.querySelectorAll('[data-weft-resident]')) {
        target.textContent = 'cleared — reload for a cold visit'
      }
    })
  }
}

// ── the channel ──────────────────────────────────────────────────────────────────────

interface Wire {
  send(frames: readonly ChannelFrame[]): Promise<void>
  client: ReturnType<typeof createChannelClient>
}

let opening: Promise<Wire> | null = null
let regionsHeld: Region[] = []

function channelPath(): string {
  return window.__weftChannel ?? '/_weft/channel'
}

/** One channel per page, opened on demand: a page that never uses one should not pay for it. */
function wire(): Promise<Wire> {
  opening ??= open()
  return opening
}

async function send(frames: readonly ChannelFrame[]): Promise<void> {
  const w = await wire()
  await w.send(frames)
}

/**
 * A refresh, and the one thing it has to say first: where the client is now.
 *
 * The server matched this channel to a page when it opened, and a refresh re-runs *that* route's
 * loader. So a control that changed the query has to re-register before it asks, or it gets the
 * old answer computed from the old URL. That is one extra POST on a path the server already
 * reads, rather than a frame the protocol would have to grow.
 */
async function refresh(slots?: readonly string[], at?: string): Promise<number> {
  const w = await wire()
  const names = slots?.length ? [...slots] : state.live
  if (!names.length) return 0
  // Every POST carries the current location, so setting it is the whole of re-registering: the
  // REFRESH frame's own request is what tells the server where the answer is computed from.
  if (at) location_ = at
  const before = state.writes
  await w.send([{ kind: 'REFRESH', header: { s: names.join(',') } }])
  // The answer arrives on the down connection, so the writes it caused are counted there.
  await new Promise((resolve) => setTimeout(resolve, 0))
  return state.writes - before
}

function encodeUp(frames: readonly ChannelFrame[]): Uint8Array<ArrayBuffer> {
  const encoded = frames.map((f) => warpFrame(f.kind as FrameKind, f.header, f.body, true)) as Frame[]
  return new Uint8Array(encodeStream(encoded))
}

/** Where the client last told the server it is. A refresh re-registers this before it asks. */
let location_ = ''

async function open(): Promise<Wire> {
  const base = channelPath()
  const id = `c-${Math.random().toString(36).slice(2, 10)}`
  location_ = window.location.pathname + window.location.search
  const epochs = createEpochs()
  staging = epochs

  const client = createChannelClient({
    epochs,
    regions: () => regionsHeld,
    onStale: (slot, reason) => log('down', `STALE ${slot} — ${reason}`),
    /**
     * The answer to a route this client asked to stage.
     *
     * Settled here rather than by the sending side because the answer arrives on the down
     * connection: the frames are applied by the reader loop, and the promise that asked for them
     * is waiting in `waiting`. A `document` answer resolves to nothing, which is the caller's
     * signal to stage it the way a page with no channel would.
     */
    onFrame: navFrames((nav) => {
      log('down', `NAV ${nav.at} ${nav.form}${nav.why ? ` — ${nav.why}` : ''}`)
      const settle = nav.epoch ? waiting.get(nav.epoch) : undefined
      if (!nav.epoch || !settle) return
      if (nav.form !== 'slots') {
        waiting.delete(nav.epoch)
        settle(null)
        return
      }
      pending.set(nav.epoch, nav)
    }),
    onAck: (ack) => log('down', `ACK ${ack.intent} ok=${ack.ok}${ack.code ? ` ${ack.code}` : ''}`),
    onRedirect: (to) => window.location.assign(to),
    /**
     * A region sent as markup rather than as a delta, and the two things that has to trigger.
     *
     * Replacing the nodes means every binding adopted inside them is pointing at nodes that are
     * no longer in the document — so the region is adopted again from the payload the new markup
     * carries. And any control or intent in it is new, so those are wired again. Without both, the
     * first HTML fallback on a page silently turned everything inside that region into decoration.
     */
    onHtml: (slot, html, showing) => {
      const target = document.querySelector(`[data-weft-slot="${slot}"]`)
      if (!target) return
      target.innerHTML = html
      void (async () => {
        // The region this frame replaced keeps its entry with the base it is now showing; the
        // regions *inside* it were adopted against nodes that no longer exist, so those are
        // replaced by whatever the new markup declares. Dropping the outer entry — which an
        // earlier version did — loses the base the next delta would be computed against.
        const fresh = await adoptRegions(target)
        const replaced = new Set(fresh.map((region) => region.slot))
        regionsHeld = [...regionsHeld.filter((region) => !replaced.has(region.slot)), ...fresh]
        const held = regionsHeld.find((region) => region.slot === slot)
        if (held) held.base = showing
        state.regions = regionsHeld.length
        wireIntents()
        wireControls()
      })()
    },
  })

  const post = async (frames: readonly ChannelFrame[]): Promise<void> => {
    for (const f of frames) log('up', describe(f))
    const response = await fetch(`${base}?c=${id}&at=${encodeURIComponent(location_)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/warp' },
      body: encodeUp(frames),
    })
    if (response.status === 202) return
    log('down', `POST refused ${response.status}: ${(await response.text()).trim().slice(0, 160)}`)
    // 409 is this connection being gone — a reload, from the server's side. Reopen on the next use.
    if (response.status === 409) {
      opening = null
      state.connected = false
    }
  }

  const decoder = createBinaryDecoder({ expect: 'down' })
  // Aborted on the way out: a chunked response the browser abandons mid-stream is reported as
  // ERR_INCOMPLETE_CHUNKED_ENCODING, which looks like a server fault and is not one.
  const leaving = new AbortController()
  window.addEventListener('pagehide', () => leaving.abort(), { once: true })
  const down = await fetch(`${base}?c=${id}&at=${encodeURIComponent(location_)}`, {
    signal: leaving.signal,
  })
  state.connected = true

  void (async () => {
    const reader = (down.body as ReadableStream<Uint8Array>).getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      const frames = decoder.push(value).filter((f) => f.kind !== 'UNKNOWN') as ChannelFrame[]
      for (const f of frames) log('down', describe(f))
      const applied = await client.apply(frames)
      state.writes += applied.writes
      /**
       * A staged route becomes staged when the last of its regions lands.
       *
       * Checked after the whole batch rather than per frame: the regions of one route arrive
       * together almost always, and asking "are they all here" once per chunk is both cheaper and
       * the only version that is correct when they do not.
       */
      for (const [epoch, nav] of pending) {
        if (epochs.staged(epoch).length < nav.slots.length) continue
        pending.delete(epoch)
        const settle = waiting.get(epoch)
        if (!settle) {
          epochs.discard(epoch)
          continue
        }
        waiting.delete(epoch)
        settle({
          kind: 'regions',
          regions: {
            epoch,
            url: new URL(nav.at, window.location.href).href,
            route: nav.route,
            slots: nav.slots,
            ...(nav.title ? { title: nav.title } : {}),
            ...(nav.css ? { css: nav.css } : {}),
            next: nav.next,
          },
        })
      }
      // A STALE frame is an invitation rather than an instruction: the client decides when to ask.
      if (applied.stale.length) await post([{ kind: 'REFRESH', header: { s: applied.stale.join(',') } }])
    }
  })().catch((error: unknown) => log('down', `reader stopped: ${String(error)}`))

  await post([
    {
      kind: 'RESIDENT',
      header: {
        warp: WARP_VERSION,
        ir: document.documentElement.dataset.weftIr ?? '2.4.0',
        forms: 'html,delta,patch',
        transport: 'stream',
      },
    },
  ])
  if (regionsHeld.length) await post([{ kind: 'HELD', header: client.held() }])

  return { send: post, client }
}

// ── navigation ───────────────────────────────────────────────────────────────────────

/**
 * A page you have not gone to yet, fetched and painting nothing.
 *
 * Every layer this needed already existed and none of them were pointed at a link. An epoch is
 * data resolved and unpainted; the resident store keeps templates across visits; and the swap is
 * the same one a control that changes the query has always done. What was missing was the notion
 * of a staged *route*: regions are keyed by slot on the page you are on, so tomorrow's prices
 * could be staged into today's page and a different page could not.
 *
 * `createStaging` is that notion one level up, keyed by URL. The document is fetched on hover,
 * parsed, and held; the click commits it, and the commit is a DOM swap rather than a request. So
 * what a navigation costs after the hover is what a swap costs, and the reader's scroll position,
 * their place in the tab order and the channel they are on all survive it.
 *
 * Every failure is a real navigation rather than a wrong one: a bad status, a redirect the server
 * decided on, a document that is not this application's, an answer that arrived too long ago.
 */
/**
 * A route held and unpainted, in one of the two forms it can arrive in.
 *
 * A **document** is the floor and the general case: fetched over HTTP by the same path a first
 * visit takes, so it renders every slot the route has whatever shell it uses. A **page of regions**
 * is the design's own version — `WARM at=`, answered by `NAV` — and it only exists when the target
 * shares this page's shell, because a different shell has different holes. What it buys is the
 * whole point of having a channel: two pages on one route share a template, so switching between
 * them arrives as the changed values rather than as a second copy of the markup.
 */
interface StagedPage {
  document: Document
  /** Where the answer came from. A guard's redirect is a decision about the URL, so it wins. */
  url: string
}

interface StagedRegions {
  /** The epoch its regions are held in. Painting is committing that epoch. */
  epoch: string
  url: string
  route: string
  slots: string[]
  title?: string
  css?: string
  /** Where readers of this route go next, from the server's own profile. */
  next: string[]
}

type Held = { kind: 'document'; page: StagedPage } | { kind: 'regions'; regions: StagedRegions }

/** Hover intent. Below this a pointer crossing a nav on its way elsewhere prefetches the lot. */
const HOVER_MS = 65

/**
 * Answers waiting on the down connection, by epoch.
 *
 * A staged route asked for over the channel is answered by frames the reader loop applies, not by
 * the promise that asked — so the asking side leaves a resolver here and the frame router settles
 * it. The grace is what makes a partial answer a fallback rather than a hang: the regions arrive
 * in one chunk almost always, and when they do not the route is staged over HTTP like any other.
 */
/** The epoch store of the open channel, for releasing a staged route nobody committed. */
let staging: Epochs | null = null

const waiting = new Map<string, (held: Held | null) => void>()
/**
 * Routes whose `NAV` has arrived and whose regions have not, all of them, yet.
 *
 * A route is only staged when every region it named is held: a partial epoch committed would paint
 * some of the next page over some of this one, which is the one thing staging exists to prevent.
 */
const pending = new Map<string, StagedNav>()
const WARM_GRACE_MS = 2_000

async function stageDocument(url: string, abort: AbortSignal): Promise<Held | null> {
  const response = await fetch(url, {
    signal: abort,
    credentials: 'same-origin',
    headers: { accept: 'text/html' },
  }).catch(() => null)
  if (!response?.ok) return null
  if (!(response.headers.get('content-type') ?? '').includes('text/html')) return null
  const next = parseDocument(await response.text())
  if (!next?.querySelector('slot[name]')) return null
  preloadStyles(next)
  return { kind: 'document', page: { document: next, url: response.url || url } }
}

/**
 * The route, asked for over the channel first and over HTTP otherwise.
 *
 * The channel is tried only when one is already open — opening a socket to stage a route nobody
 * has clicked would be paying for speculation twice — and the server decides whether it can answer
 * as regions at all. `form: 'document'` comes back for a target with a different shell, and the
 * fallback below is then the same path a page with no channel takes.
 */
const routes = createStaging<Held>({
  /**
   * A staged route that is dropped gives its epoch back.
   *
   * The staging model evicts the oldest when the ceiling is reached and expires an answer nobody
   * committed, and a route staged as regions holds a staged epoch either way. Left behind, that
   * epoch is the next page's values kept in memory for a page nobody is going to — and still
   * committable by something that no longer knows what it contains.
   */
  release: (held: Held) => {
    if (held.kind === 'regions') staging?.discard(held.regions.epoch)
  },
  load: async (url, abort) => {
    const open_ = opening
    if (!open_ || !window.__weftChannel) return stageDocument(url, abort)

    const epoch = `n-${Math.random().toString(36).slice(2, 8)}`
    const answered = new Promise<Held | null>((resolve) => {
      waiting.set(epoch, resolve)
      window.setTimeout(() => {
        if (waiting.delete(epoch)) resolve(null)
      }, WARM_GRACE_MS)
    })
    const w = await open_
    await w.send([warmFrame(new URL(url).pathname + new URL(url).search, epoch) as ChannelFrame])
    const held = await answered
    if (held) return held
    // Either the server sent us to the document, or the regions did not all arrive. Both are the
    // same fallback, and it is the path every page without a channel is already on.
    return stageDocument(url, abort)
  },
})

/**
 * Routes whose answer is *held*, which is what the readouts say and what a click can use.
 *
 * `routes.open` includes the ones still in flight, and a fetch that has started is not an answer
 * that is ready: a click on one of those is handed back to the browser, not committed.
 */
function syncStaged(): void {
  state.staged = routes.open.filter((url) => routes.state(url) === 'ready')
}

/** The URL the framework believes it is showing. `location` has already moved by `popstate`. */
let here = typeof window === 'undefined' ? null : new URL(window.location.href)

function linkFacts(link: HTMLAnchorElement): LinkFacts {
  return {
    href: link.href,
    target: link.target,
    rel: link.rel,
    download: link.hasAttribute('download'),
  }
}

function samePage(url: URL): boolean {
  return url.pathname === window.location.pathname && url.search === window.location.search
}

/**
 * Whether a link is worth fetching before it is clicked.
 *
 * A prefetch is a render the server performs for a page that may never be asked for, so the
 * refusals are the ones where that cost is not the reader's to pay: `data-weft-prefetch="off"` on
 * the link or the document, a connection the browser has told us to save data on, and 2G. On any
 * of them the click still works — it waits for the answer instead of having it.
 */
function prefetchable(link: HTMLAnchorElement): boolean {
  if (!navigable(linkFacts(link), window.location.href)) return false
  if (link.dataset.weftPrefetch === 'off') return false
  if (document.documentElement.dataset.weftPrefetch === 'off') return false
  const connection = (navigator as { connection?: { saveData?: boolean; effectiveType?: string } }).connection
  if (connection?.saveData) return false
  if (connection?.effectiveType && connection.effectiveType.includes('2g')) return false
  return !samePage(new URL(link.href, window.location.href))
}

function parseDocument(html: string): Document | null {
  let next: Document
  try {
    next = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return null
  }
  /**
   * An out-of-order answer arrives unfilled, and a parsed document runs no scripts.
   *
   * The regions of a streamed response are not inside their holes on the wire: each one is a
   * `<template data-w="…">` after the shell, and the inline filler moves it to the anchor comment
   * left in the hole. `DOMParser` executes nothing, so the holes of a document parsed this way are
   * empty — and swapping them in would have emptied every region on the page, which is exactly
   * what it did to the dashboard.
   *
   * So the same move is made here, against the inert document, before anything is read out of it.
   */
  for (const carrier of next.querySelectorAll('template[data-w]')) {
    const hole = next.querySelector(`slot[name="${carrier.getAttribute('data-w') ?? ''}"]`)
    if (hole) hole.replaceChildren((carrier as HTMLTemplateElement).content)
    carrier.remove()
  }
  return next
}

function styleHrefs(from: Document): string[] {
  return [...from.head.querySelectorAll('link[rel="stylesheet"]')].map((n) => (n as HTMLLinkElement).href)
}

/**
 * The next page's stylesheet, fetched while it is staged and applied to nothing.
 *
 * `preload` rather than `stylesheet` is the whole point: a second page bundle appended as a
 * stylesheet would apply its rules to the page being looked at, which is the one thing staging
 * is not allowed to do. Preloaded, the bytes are in the cache and the commit is a cache hit.
 */
function preloadStyles(next: Document): void {
  const have = new Set([
    ...styleHrefs(document),
    ...[...document.head.querySelectorAll('link[rel="preload"][as="style"]')].map(
      (n) => (n as HTMLLinkElement).href,
    ),
  ])
  for (const href of styleHrefs(next)) {
    if (have.has(href)) continue
    const link = document.createElement('link')
    link.rel = 'preload'
    link.as = 'style'
    link.href = href
    document.head.append(link)
  }
}

/** The cascade the next page links, in place before it paints. */
async function applyStyles(next: Document): Promise<void> {
  const holding = new Map<string, HTMLLinkElement>()
  for (const node of document.head.querySelectorAll('link[rel="stylesheet"]')) {
    holding.set((node as HTMLLinkElement).href, node as HTMLLinkElement)
  }
  const wanted = styleHrefs(next)
  const loading: Promise<unknown>[] = []
  for (const href of wanted) {
    if (holding.has(href)) continue
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = href
    loading.push(
      new Promise((resolve) => {
        link.addEventListener('load', resolve, { once: true })
        link.addEventListener('error', resolve, { once: true })
      }),
    )
    document.head.append(link)
  }
  // Awaited, because painting the next page with the last one's stylesheet is precisely the
  // flash this path exists to avoid. The bytes are already cached from the preload, so what is
  // waited on is a task rather than a round trip.
  await Promise.all(loading)
  for (const [href, node] of holding) if (!wanted.includes(href)) node.remove()
}

function syncAttributes(target: Element, from: Element): void {
  for (const attribute of from.attributes) target.setAttribute(attribute.name, attribute.value)
  // `getAttributeNames` rather than the live map, which shrinks as it is read from.
  for (const name of target.getAttributeNames()) {
    if (!from.hasAttribute(name)) target.removeAttribute(name)
  }
}

function syncHead(next: Document): void {
  document.title = next.title
  for (const node of next.head.querySelectorAll('meta[name]')) {
    const name = node.getAttribute('name') as string
    const held = document.head.querySelector(`meta[name="${CSS.escape(name)}"]`)
    if (held) held.setAttribute('content', node.getAttribute('content') ?? '')
    else document.head.append(document.importNode(node, true))
  }
}

/**
 * Put the reader back at a position, and again on the next frame if it did not take.
 *
 * The document has just been rewritten and its height is whatever layout has got to, so asking
 * for a position past the bottom of a document that is momentarily short clamps it to the top —
 * and the browser's own clamp lands *after* this runs, so checking once and finding nothing wrong
 * still ends up at the top a frame later.
 */
function keepAt(y: number): void {
  const land = (): void => window.scrollTo({ top: y, behavior: 'instant' as ScrollBehavior })
  land()
  requestAnimationFrame(() => {
    if (Math.abs(scrollY - y) > 4) land()
  })
}

function landAt(url: URL, y: number): void {
  const anchor = url.hash ? document.getElementById(url.hash.slice(1)) : null
  if (anchor) {
    anchor.scrollIntoView()
    return
  }
  keepAt(y)
}

/**
 * Where the client is now, and what it is holding there.
 *
 * The server resolves a refresh by matching the path this client last registered against the
 * same route table the document went through, so a navigation that did not re-register would ask
 * for the new page and be answered from the old one. And the held map is keyed by slot, which is
 * a name that belongs to a page: `only` says this is the whole of what is held, so the page that
 * was left does not go on being refreshed and invalidated for.
 */
async function rebind(url: URL): Promise<void> {
  // Set before anything can be sent, and whether or not a channel exists yet: every POST carries
  // it, so a channel opened later by the page that has just arrived registers the right path.
  location_ = url.pathname + url.search
  const held = opening
  if (!held) {
    if (liveRegions) await wire()
    return
  }
  const w = await held
  await w.send([{ kind: 'HELD', header: w.client.held({ only: true }) }])
}

/**
 * The commit: a staged page becomes the page, in one turn and with no request in it.
 *
 * The body is replaced rather than the holes, because a layout's own values — the title, the
 * heading, whatever the route declared — are holes in the shell rather than slots in it, and a
 * page swapped hole by hole would have kept the last one's chrome.
 */
/**
 * A route staged as regions, painted.
 *
 * The commit is the epoch: every region flips together, and the ones the server sent as deltas are
 * one DOM write per changed value. What has to happen around it is the same list a document swap
 * has, minus the document — the cascade in place before anything paints, the title, the address
 * bar, and the channel told where this client is now.
 */
async function commitRegions(staged: StagedRegions, mode: 'push' | 'restore', y: number): Promise<number> {
  const url = new URL(staged.url, window.location.href)
  if (staged.css) await ensureStylesheet(staged.css)
  if (staged.title) document.title = staged.title

  if (mode === 'push') {
    const state_ = (window.history.state ?? {}) as Record<string, unknown>
    window.history.replaceState({ ...state_, weftY: Math.round(scrollY) }, '')
  }

  const w = await wire()
  const applied = await w.client.apply([{ kind: 'COMMIT', header: { epoch: staged.epoch } }])
  state.writes += applied.writes
  if (mode === 'push') window.history.pushState({ weftY: 0 }, '', url.href)
  here = url

  // The regions are new nodes wherever the server sent markup, so anything inside them is new.
  wireIntents()
  wireControls()
  observed?.()
  const painted = performance.now()
  landAt(url, y)
  await rebind(url)
  // What the server's own numbers say this reader is likely to want next.
  for (const route of staged.next.slice(0, 2)) {
    void routes.stage(stagingKey(route, window.location.href)).then(syncStaged)
  }
  return painted
}

/** A stylesheet the next page links, in place and loaded before anything paints. */
async function ensureStylesheet(href: string): Promise<void> {
  const absolute = new URL(href, window.location.href).href
  for (const node of document.head.querySelectorAll('link[rel="stylesheet"]')) {
    if ((node as HTMLLinkElement).href === absolute) return
  }
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = href
  const loaded = new Promise((resolve) => {
    link.addEventListener('load', resolve, { once: true })
    link.addEventListener('error', resolve, { once: true })
  })
  document.head.append(link)
  await loaded
}

async function commitPage(page: StagedPage, mode: 'push' | 'restore', y: number): Promise<number> {
  const next = page.document
  if (!next.body) return 0
  const url = new URL(page.url, window.location.href)

  await applyStyles(next)
  syncHead(next)
  syncAttributes(document.documentElement, next.documentElement)

  if (mode === 'push') {
    // Recorded against the entry being left, which is the only entry that can hold it.
    const state_ = (window.history.state ?? {}) as Record<string, unknown>
    window.history.replaceState({ ...state_, weftY: Math.round(scrollY) }, '')
  }

  syncAttributes(document.body, next.body)
  document.body.replaceChildren(...document.importNode(next.body, true).childNodes)
  if (mode === 'push') window.history.pushState({ weftY: 0 }, '', url.href)
  here = url

  // Everything the last page bound is pointing at nodes that are no longer in the document, and
  // a signal declared by a page nobody is on is state with no owner.
  writable.clear()
  intentTargets.clear()
  state.live = []
  liveRegions = false
  regionsHeld = await adoptRegions()
  state.regions = regionsHeld.length
  wireIntents()
  wireControls()
  await wireRuntimeReadouts()
  const painted = performance.now()
  observed?.()
  speculate()
  landAt(url, y)
  // After the number: rebinding is a POST, and what the click bought is a page that is on screen
  // and interactive, not a round trip that happens to follow it.
  await rebind(url)
  return painted
}

/**
 * A click is answered here only when the answer is already in hand.
 *
 * The alternative — wait for the fetch the hover started, then swap — makes a slow page *worse*
 * than the browser would have made it. A document response streams: the shell paints, then each
 * region as it arrives. A `fetch` of the same document has to be read to the last byte before
 * there is anything to parse, so waiting on one means the reader sits on the page they asked to
 * leave, with no address-bar spinner to say why. The demo's dashboard makes it obvious, because
 * its slots are deliberately slow.
 *
 * So: staged, and this is instant. Not staged, and it is a real navigation, which is what a link
 * has always cost — and the request in flight is dropped rather than raced.
 */
async function go(href: string, mode: 'push' | 'restore', y = 0): Promise<boolean> {
  const url = new URL(href, window.location.href)
  const key = stagingKey(url.href, window.location.href)
  const started = performance.now()

  if (!routes.ready(key)) {
    routes.discard(key)
    syncStaged()
    state.nav = { ...state.nav, cold: state.nav.cold + 1 }
    return false
  }
  const claimed = await routes.claim(key)
  syncStaged()
  if (!claimed.value) return false

  const held = claimed.value
  const painted =
    held.kind === 'regions'
      ? await commitRegions(held.regions, mode, y)
      : await commitPage(held.page, mode, y)
  if (!painted) return false
  state.nav = { ...state.nav, staged: state.nav.staged + 1, lastMs: Math.round(painted - started) }
  log('up', `NAV ${url.pathname}${url.search} ${state.nav.lastMs}ms`)
  return true
}

/**
 * Where a route change lands, and who decides.
 *
 * The link wins, then the application's config, then `top` — which is what a navigation has always
 * done, and the reason it is the default rather than the clever option. `preserve` exists because
 * on some pages the scroll position *is* the reader's place: a long list whose filter is in the
 * URL, or a document with a chapter per route. Back and forward ignore both and restore the
 * position recorded against the entry being returned to.
 */
function scrollFor(link?: HTMLAnchorElement | null): 'top' | 'preserve' {
  const asked = link?.dataset.weftScroll ?? window.__weftScroll
  return asked === 'preserve' ? 'preserve' : 'top'
}

async function navigate(href: string, scroll: 'top' | 'preserve' = scrollFor()): Promise<boolean> {
  const y = scroll === 'preserve' ? Math.round(scrollY) : 0
  if (await go(href, 'push', y)) return true
  /**
   * The same link, answered by the browser — and `preserve` has to mean the same thing there.
   *
   * A click on a route that was not staged is a real navigation, and a real navigation lands at
   * the top of a new document. Without this, whether the reader kept their place depended on
   * whether they happened to hover long enough first, which is a setting that works most of the
   * time and is therefore worse than one that does not work at all.
   */
  const url = new URL(href, window.location.href)
  if (y > 0) handOff(url.pathname, y)
  window.location.assign(url.href)
  return false
}

/**
 * A link the reader has been looking at.
 *
 * The strongest mobile signal there is, and it needs no gesture: a phone reader scrolls a link
 * into view seconds before tapping it, which is far more warning than a hover ever gives. What
 * makes it defensible rather than a load-time stampede is entirely in the bounds.
 *
 * Only links inside a region — `[data-weft-slot]` — so the chrome is excluded. A nav is on every
 * page and lists every page; staging all of it because the reader can see it would be a fetch per
 * link for a page they came to read. Only after the link has been visible for a moment, because
 * scrolling past is not looking at. And only two, so hover and a press still have somewhere to
 * go inside the ceiling of four.
 */
const VIEWPORT_DWELL_MS = 300
const VIEWPORT_MAX = 2

function watchViewport(): void {
  if (typeof IntersectionObserver === 'undefined') return
  let staged = 0
  const dwelling = new Map<Element, number>()

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const link = entry.target as HTMLAnchorElement
        if (!entry.isIntersecting) {
          const timer = dwelling.get(link)
          if (timer !== undefined) window.clearTimeout(timer)
          dwelling.delete(link)
          continue
        }
        if (dwelling.has(link) || staged >= VIEWPORT_MAX) continue
        dwelling.set(
          link,
          window.setTimeout(() => {
            dwelling.delete(link)
            if (staged >= VIEWPORT_MAX || !prefetchable(link)) return
            staged++
            observer.unobserve(link)
            void routes.stage(stagingKey(link.href, window.location.href)).then(syncStaged)
          }, VIEWPORT_DWELL_MS),
        )
      }
    },
    { rootMargin: '0px' },
  )

  const observe = (): void => {
    for (const node of document.querySelectorAll('[data-weft-slot] a[href]')) {
      if (prefetchable(node as HTMLAnchorElement)) observer.observe(node)
    }
  }
  observe()
  // A region replaced by a delta or a commit brings new links with it, and an observer only knows
  // about the nodes it was given.
  observed = observe
}

/** Re-observed after a swap. Set by `watchViewport`; a page without one does nothing. */
let observed: (() => void) | null = null

/**
 * The browser's own heuristics, told which links are worth them.
 *
 * Speculation rules are the one mechanism here that is not this framework's: the engine decides
 * when to prefetch, using signals it has and we do not — how the pointer is moving, what the
 * connection is doing, whether the reader is on a metered network. `moderate` is roughly
 * "hovered or pressed", which is the same intent as the code above and better tuned per platform.
 *
 * Chrome and Android WebView have it; Safari does not, which is the wrong half for iOS. So this is
 * a layer over the two above rather than a replacement: where it exists the cache is warm before
 * `stage` is called, and where it does not nothing changes.
 */
function speculate(): void {
  const supports = (HTMLScriptElement as { supports?(type: string): boolean }).supports
  if (!supports?.call(HTMLScriptElement, 'speculationrules')) return
  if (document.documentElement.dataset.weftPrefetch === 'off') return
  const hrefs = [...document.querySelectorAll('[data-weft-slot] a[href]')]
    .filter((node) => prefetchable(node as HTMLAnchorElement))
    .map((node) => new URL((node as HTMLAnchorElement).href).pathname)
  if (!hrefs.length) return

  const script = document.createElement('script')
  script.type = 'speculationrules'
  script.textContent = JSON.stringify({
    prefetch: [{ source: 'list', urls: [...new Set(hrefs)].slice(0, 8), eagerness: 'moderate' }],
  })
  document.querySelector('script[type="speculationrules"][data-weft]')?.remove()
  script.dataset.weft = 'speculate'
  document.head.append(script)
}

/**
 * Links, answered by the framework only where the markup says it may.
 *
 * Delegated at the document rather than wired per link, because a region replaced by a delta
 * brings new links with it and a listener attached per link is a listener that will be missed
 * once. The click is taken on the bubble rather than on capture, so an application that calls
 * `preventDefault` is not overruled by the framework it is running on.
 */
function wireNavigation(): void {
  /**
   * The framework restores the position, so the browser is asked to stop.
   *
   * Two mechanisms both trying to put the reader back is worse than either: the engine restores
   * the position an entry had when it was left, and it does so *after* load — so a page that this
   * runtime had already put back at 240 was quietly returned to the top a frame later, and
   * `navigation.scroll` and a restored back position both looked like they did nothing. Taking it
   * over means every path has to record, so leaving a page records where it was.
   */
  try {
    window.history.scrollRestoration = 'manual'
  } catch {
    // An engine without the property. It restores its own way, and the re-land below still runs.
  }
  window.addEventListener('pagehide', rememberScroll)

  let intent: number | null = null
  const cancel = (): void => {
    if (intent !== null) window.clearTimeout(intent)
    intent = null
  }
  const consider = (event: Event): void => {
    const link = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!link || !prefetchable(link)) return
    const href = link.href
    cancel()
    intent = window.setTimeout(() => {
      // Asked again on the way out, not only on the way in. Clicking a link focuses it, so the
      // click itself schedules one of these — and by the time it fires the page it names is the
      // page you are on, which would stage the document you are already looking at.
      const url = new URL(href, window.location.href)
      if (samePage(url)) return
      void routes.stage(stagingKey(url.href, window.location.href)).then(syncStaged)
    }, HOVER_MS)
  }

  /**
   * Staged now, with no hover intent to wait for.
   *
   * `pointerdown` is one event for mouse, pen and touch, and it fires on finger-down rather than
   * on the tap resolving — which is the only warning a phone gives, since a phone has no hover at
   * all. The window is the press plus the browser's tap handling, roughly 80–150 ms: a head start
   * rather than an answer, and when it is not enough the click falls back the way it already does.
   *
   * No delay, because there is nothing to disambiguate. A pointer crossing a nav on its way
   * somewhere else is what hover intent protects against; a finger pressed on a link is a
   * decision.
   */
  const now_ = (event: Event): void => {
    const link = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!link || !prefetchable(link)) return
    cancel()
    void routes.stage(stagingKey(link.href, window.location.href)).then(syncStaged)
  }

  document.addEventListener('pointerover', consider, { passive: true })
  document.addEventListener('pointerout', cancel, { passive: true })
  // A keyboard reader never hovers either, and focus is the same signal by another name.
  document.addEventListener('focusin', consider, { passive: true })
  document.addEventListener('pointerdown', now_, { passive: true })
  watchViewport()
  speculate()

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented) return
    const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
    if (!plainClick({ modified, button: event.button })) return
    const link = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!link || !navigable(linkFacts(link), window.location.href)) return
    const url = new URL(link.href, window.location.href)
    // The same page again is a reload, and a reload is the browser's to do.
    if (samePage(url)) return
    event.preventDefault()
    void navigate(url.href, scrollFor(link))
  })

  window.addEventListener('popstate', (event) => {
    const url = new URL(window.location.href)
    // A fragment on the page being looked at: the browser is scrolling, not navigating.
    if (here && url.pathname === here.pathname && url.search === here.search) {
      here = url
      return
    }
    const y = ((event.state ?? {}) as { weftY?: number }).weftY ?? 0
    void (async () => {
      if (await go(url.href, 'restore', y)) return
      /**
       * Nothing staged for the entry being returned to, so it is loaded — streamed, the way the
       * first visit was. What a reload loses is the position, because the browser restores scroll
       * for a history traversal and this is a fresh navigation to the same URL.
       *
       * So the position recorded on that entry is handed to the same session storage a
       * framework-caused reload already uses, and boot puts it back before the first paint.
       */
      // Written even when it is zero, so a position recorded on an earlier visit to this path
      // cannot be restored over a page the reader left at the top: boot removes the key it reads,
      // whatever it says.
      handOff(url.pathname, y)
      window.location.reload()
    })()
  })
}

// ── boot ─────────────────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  intentIds = window.__weftIntents ?? {}
  restoreScroll()
  upgradeIntentForms()
  state.stage = 'adopting'
  regionsHeld = await adoptRegions()
  state.regions = regionsHeld.length
  state.stage = 'intents'
  wireIntents()
  wireControls()
  wireNavigation()
  await wireRuntimeReadouts()
  state.stage = 'ready'
  // A page with a live region wants the channel now; every other page opens one on first use.
  if (regionsHeld.length && liveRegions) await wire()
  // The application's own client code, last, so it can see adopted regions and send intents. It
  // is loaded rather than bundled: there is no build step here to bundle it with.
  if (window.__weftClient) {
    state.stage = 'app'
    await import(window.__weftClient)
  }
  state.stage = 'running'
  state.readyAt = Math.round(performance.now())
}

void boot().catch((error: unknown) => {
  state.stage = `failed: ${String(error)}`
  log('down', `boot failed: ${String(error)}`)
})
