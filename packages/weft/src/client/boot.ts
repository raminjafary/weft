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

const state: WeftState = { regions: 0, writes: 0, connected: false, stage: 'loaded', frames: [] }
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

function payloads<T>(id: string): T[] {
  const out: T[] = []
  for (const node of document.querySelectorAll(`script[type="application/json"][data-weft="${id}"]`)) {
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
async function adoptRegions(): Promise<Region[]> {
  const entries = payloads<AdoptPayload>('adopt').flat()
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
    if (entry.live) liveRegions = true
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
  const form = element.closest('form')
  if (form) return Object.fromEntries(new FormData(form) as unknown as Iterable<[string, string]>)

  const payload: Record<string, string> = {}
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const own = Object.entries(node.dataset).filter(([key]) => !key.startsWith('weft'))
    if (!own.length) continue
    for (const [key, value] of own) if (value !== undefined && !(key in payload)) payload[key] = value
    break
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
function wireIntents(): void {
  for (const node of document.querySelectorAll('[data-weft-intent]')) {
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

function encodeUp(frames: readonly ChannelFrame[]): Uint8Array<ArrayBuffer> {
  const encoded = frames.map((f) => warpFrame(f.kind as FrameKind, f.header, f.body, true)) as Frame[]
  return new Uint8Array(encodeStream(encoded))
}

async function open(): Promise<Wire> {
  const base = channelPath()
  const id = `c-${Math.random().toString(36).slice(2, 10)}`
  // The server matches the page's own path to a route, so a refresh re-runs that route's loader
  // rather than a slot source somebody had to register by hand.
  const at = encodeURIComponent(window.location.pathname + window.location.search)
  const url = `${base}?c=${id}&at=${at}`
  const epochs = createEpochs()

  const client = createChannelClient({
    epochs,
    regions: () => regionsHeld,
    onStale: (slot, reason) => log('down', `STALE ${slot} — ${reason}`),
    onAck: (ack) => log('down', `ACK ${ack.intent} ok=${ack.ok}${ack.code ? ` ${ack.code}` : ''}`),
    onRedirect: (to) => window.location.assign(to),
    onHtml: (slot, html) => {
      const target = document.querySelector(`[data-weft-slot="${slot}"]`)
      if (target) target.innerHTML = html
    },
  })

  const post = async (frames: readonly ChannelFrame[]): Promise<void> => {
    for (const f of frames) log('up', describe(f))
    const response = await fetch(url, {
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
  const down = await fetch(url, { signal: leaving.signal })
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
