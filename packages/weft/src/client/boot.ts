import {
  adopt,
  computed,
  createChannelClient,
  createEpochs,
  digest,
  openResident,
  signal,
  type ChannelFrame,
  type ClientTemplate,
  type Readable,
  type Region,
} from '@weft/client'
import { createBinaryDecoder, encodeStream, frame as warpFrame, type Frame, type FrameKind } from '@weft/warp'

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
}

declare global {
  interface Window {
    weft?: WeftState
    /** Set by the served prelude: the framework knows these, the file cannot derive them. */
    __weftIntents?: Record<string, string>
    __weftChannel?: string
    __weftClient?: string
  }
}

const state: WeftState = {
  regions: 0,
  writes: 0,
  connected: false,
  stage: 'loaded',
  frames: [],
  live: [],
  refresh: (slots, at) => refresh(slots, at),
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

async function apply(): Promise<void> {
  const url = urlFromControls()
  if (!state.live.length) {
    window.location.assign(url.toString())
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
      default:
        break
    }
  }
}

async function wireRuntimeReadouts(): Promise<void> {
  const stats = document.querySelectorAll('[data-weft-stat]')
  const resident = document.querySelectorAll('[data-weft-resident]')
  const forget = document.querySelectorAll('[data-weft-forget]')
  if (stats.length) {
    paintStats()
    // Polled rather than pushed: a delta arriving is not an event the application asked for, and
    // a subscription nobody unsubscribes from outlives the element it was painting.
    window.setInterval(paintStats, 500)
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

  const client = createChannelClient({
    epochs,
    regions: () => regionsHeld,
    onStale: (slot, reason) => log('down', `STALE ${slot} — ${reason}`),
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
      // A STALE frame is an invitation rather than an instruction: the client decides when to ask.
      if (applied.stale.length) await post([{ kind: 'REFRESH', header: { s: applied.stale.join(',') } }])
    }
  })().catch((error: unknown) => log('down', `reader stopped: ${String(error)}`))

  await post([
    {
      kind: 'RESIDENT',
      header: {
        warp: '1.2.0',
        ir: document.documentElement.dataset.weftIr ?? '2.4.0',
        forms: 'html,delta,patch',
        transport: 'stream',
      },
    },
  ])
  if (regionsHeld.length) await post([{ kind: 'HELD', header: client.held() }])

  return { send: post, client }
}

// ── boot ─────────────────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  intentIds = window.__weftIntents ?? {}
  state.stage = 'adopting'
  regionsHeld = await adoptRegions()
  state.regions = regionsHeld.length
  state.stage = 'intents'
  wireIntents()
  wireControls()
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
}

void boot().catch((error: unknown) => {
  state.stage = `failed: ${String(error)}`
  log('down', `boot failed: ${String(error)}`)
})
