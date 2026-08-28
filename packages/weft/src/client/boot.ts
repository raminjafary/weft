import {
  adopt,
  computed,
  createChannelClient,
  createEpochs,
  createStaging,
  digest,
  createExposure,
  createKnown,
  discoverFrame,
  exposedFrames,
  navFrames,
  navigable,
  patchFrames,
  planFrames,
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
} from '@weftjs/client'
import {
  concatBytes,
  createBinaryDecoder,
  encodeBinaryFrame,
  encodeStream,
  frame as warpFrame,
  WARP_VERSION,
  type Frame,
  type FrameKind,
} from '@weftjs/warp'

/**
 * The client, for every application. Three jobs: adopt whatever the server said is adoptable, fire
 * intents staged into an epoch, and on a page with a live region hold a channel open. No
 * framework-specific protocol here — frames are encoded by the real codec.
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
  /** The plan's declared refresh interval, and its conditions — the fallback for invalidation that
   * cannot cross a tier boundary. See `spec/kernel/composition.md`. */
  refresh?: { everyMs: number; when?: readonly string[] }
}

interface WeftState {
  regions: number
  writes: number
  connected: boolean
  /** How far boot got. A silent failure in an async boot looks exactly like a page with no script. */
  stage: string
  /** When this page became interactive, on its own clock: the number a staged navigation is compared against. */
  readyAt: number
  frames: { dir: 'up' | 'down'; text: string }[]
  /** Slots on this page the server will refresh over the channel. Empty means there is nothing to ask for. */
  live: string[]
  /**
   * Ask the server for these slots again, optionally from a different URL — one frame and one
   * delta rather than a whole new document. `at` re-registers where the client is.
   */
  refresh(slots?: readonly string[], at?: string): Promise<number>
  /** Routes fetched and unpainted, by URL. Staging one cannot disturb the page they are staged from. */
  staged: string[]
  /** Navigations from this page, by what the click cost. `staged` answered from a route already
   * fetched; `cold` handed back to the browser. */
  nav: { staged: number; cold: number; lastMs: number }
  /** Go somewhere, the way a click on a link would. False when it fell back to a real navigation. */
  navigate(href: string, scroll?: 'top' | 'preserve'): Promise<boolean>
  /** Route patterns this page has been told about, from `PLAN` frames. */
  known: string[]
  /** Ask the server about a subtree of the plan: `weft.discover('/checkout/*')`. Cheap — describes routes rather than rendering them. */
  discover(prefix: string): Promise<string[]>
  /**
   * A shell value this page offers the regions inside it: `weft.exposed('locale')`. Read-only, and
   * in the signal graph. `E_NOT_EXPOSED` rather than `undefined` for a name the shell does not
   * expose. See `spec/kernel/composition.md`.
   */
  exposed(name: string): Readable<string>
  /** Every name this page's shell exposes, in the order the server declared them. */
  exposes: string[]
  /**
   * Ask the server for a catalogue entry, by opaque id or by name, and put the answer in a slot:
   * `weft.render('card.product', 'body', { sku: 'OIL-2L' })`. Everything about whether the call is
   * allowed is the server's.
   */
  render(id: string, slot: string, params?: unknown): Promise<number>
}

declare global {
  interface Window {
    weft?: WeftState
    /** Set by the served prelude: the framework knows these, the file cannot derive them. */
    __weftIntents?: Record<string, string>
    __weftChannel?: string
    /** False when this deployment cannot hold a downstream open — a serverless function. See `spec/kernel/transport.md`. */
    __weftHold?: boolean
    __weftClient?: string
    /** What a route change does to the scroll position: the config's `navigation.scroll`. */
    __weftScroll?: 'top' | 'preserve'
    /** Intent ids this deployment will not run without a token it minted. */
    __weftSigned?: string[]
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
  known: [],
  discover: (prefix) => discover(prefix),
  exposed: (name) => exposure.read(name),
  render: (id, slot, params) => render(id, slot, params),
  get exposes() {
    return exposure.names
  },
}

/**
 * What this page has been told about routes it has not been to. Filled by `PLAN` frames — one
 * arrives unasked when the channel opens. See `spec/client/navigation.md`.
 */
const known = createKnown()
/**
 * The shell values this page offers its regions. Empty until the channel opens, and that is not a
 * gap: a region's *first* render already had the values from the composite.
 */
const exposure = createExposure()
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

/**
 * A refused intent, said out loud: telling you one was refused is the framework's dispatch, so it
 * is the framework's job to say so. `[data-weft-toasts]` in the markup is where it goes instead.
 */
const TOAST_MS = 8_000

function toast(code: string, detail: string, kind: 'bad' | 'ok' = 'bad'): void {
  const box =
    document.querySelector('[data-weft-toasts]') ??
    (() => {
      const made = document.createElement('div')
      made.className = 'weft-toasts'
      made.dataset.weftToasts = ''
      made.setAttribute('role', 'status')
      // Polite: worth announcing, not worth interrupting a reader mid-sentence for.
      made.setAttribute('aria-live', 'polite')
      document.body.append(made)
      return made
    })()

  const node = document.createElement('div')
  node.className = 'weft-toast'
  node.dataset.kind = kind
  const said = document.createElement('div')
  const name = document.createElement('code')
  name.textContent = code
  const why = document.createElement('p')
  why.textContent = detail
  said.append(name, why)
  const close = document.createElement('button')
  close.type = 'button'
  close.setAttribute('aria-label', 'dismiss')
  close.textContent = '×'
  close.addEventListener('click', () => node.remove())
  node.append(said, close)
  box.append(node)
  window.setTimeout(() => node.remove(), TOAST_MS)
}

/**
 * What a refusal means, where the framework can say more than the dispatch did. Only two entries,
 * deliberately: a dispatch's `detail` already names most of it, and a second copy would go stale.
 */
const REFUSALS: Record<string, string> = {
  E_INTENT_UNSIGNED:
    'this intent needs a token, and a plain form cannot carry one — see spec/kernel/authority.md',
  E_NO_CAPABILITY_CHECK: 'the intent declares a capability and weft.config.ts binds no authority',
}

function refused(code: string, detail: string): void {
  toast(code, REFUSALS[code] ?? detail)
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
 * `adopt` binds nodes to signals; it does not invent them. The framework creates them from the
 * declarations the server shipped. See `spec/client/adoption.md`.
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
    // A constant readable: a derived value is only built when every reference is bound.
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
        // The local half of an optimistic write: the control updates the signal now, and the
        // server's answer arrives in an epoch that paints over it or rolls it back.
        const binding = intentTargets.get(intent)
        if (binding) {
          const next = Number((target as HTMLInputElement).value)
          if (Number.isFinite(next)) writable.get(binding)?.set(next)
        }
        void fire(intent, payloadOf(target))
      },
    })
    if (entry.live) {
      liveRegions = true
      state.live.push(entry.slot)
      if (entry.refresh) schedule(entry.slot, entry.refresh)
    }
    regions.push({ slot: entry.slot, adopted, base: entry.base })
  }

  document.cookie = `weft-resident=${digest(Object.keys(resident))}; path=/; max-age=600; SameSite=Lax`
  return regions
}

/**
 * A region's declared interval, asked under the conditions it declared. Conditions are checked at
 * the moment of asking rather than by starting and stopping the timer, so the cadence a deployment
 * declared never moves.
 */
const scheduled = new Set<string>()

function schedule(slot: string, spec: { everyMs: number; when?: readonly string[] }): void {
  if (spec.everyMs <= 0 || scheduled.has(slot)) return
  scheduled.add(slot)
  const conditions = spec.when ?? ['visible']
  const timer = window.setInterval(() => {
    if (!allowed(conditions)) return
    void refresh([slot])
  }, spec.everyMs)
  // A page being unloaded needs no more answers.
  window.addEventListener('pagehide', () => window.clearInterval(timer), { once: true })
}

function allowed(conditions: readonly string[]): boolean {
  for (const condition of conditions) {
    if (condition === 'visible' && document.visibilityState !== 'visible') return false
    if (condition === 'focused' && !document.hasFocus()) return false
    // `idle` asks about the reader, not the document: nothing typed or pointed at recently.
    if (condition === 'idle' && performance.now() - lastActivity < 5_000) return false
    if (condition === 'always') continue
  }
  return true
}

let lastActivity = 0
for (const event of ['pointerdown', 'keydown', 'wheel'] as const) {
  window.addEventListener(
    event,
    () => {
      lastActivity = performance.now()
    },
    { passive: true },
  )
}

// ── intents ──────────────────────────────────────────────────────────────────────────

/**
 * The name an author wrote in their markup, to the opaque id that goes on the wire. Arrives in the
 * boot prelude rather than in the page, so a document's bytes carry no server names.
 */
let intentIds: Record<string, string> = {}

function intentFrame(id: string, input: unknown, token?: string): ChannelFrame {
  return {
    kind: 'INTENT',
    // `t` beside the payload rather than in it: a token inside what it signs could never verify.
    header: { i: id, e: `o-${Date.now().toString(36)}`, ...(token ? { t: token } : {}) },
    body: new TextEncoder().encode(JSON.stringify(input)),
  }
}

/**
 * The intents this deployment will not run without a signature. The token is fetched at the moment
 * of the interaction — a token rendered into the page would be cached with it. See `spec/kernel/authority.md`.
 */
function signedIntent(id: string): boolean {
  return (window.__weftSigned ?? []).includes(id)
}

async function mint(id: string, payload: unknown): Promise<string | null> {
  const response = await fetch('/_weft/token', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ intent: id, payload }),
  }).catch(() => null)
  if (!response?.ok) {
    const body = response
      ? ((await response.json().catch(() => ({}))) as { code?: string; detail?: string })
      : {}
    log('up', `no token for ${id}: ${response?.status ?? 'no answer'} ${body.code ?? ''}`)
    // Minting runs the same capability check the dispatch would, so a caller who may not run the
    // intent is told here rather than after a round trip.
    refused(body.code ?? 'E_NO_TOKEN', body.detail ?? 'no token could be minted for this intent')
    return null
  }
  const minted = (await response.json()) as { token?: string }
  return minted.token ?? null
}

/** One intent, sent — with a token first where the intent requires one. */
async function fire(id: string, payload: unknown): Promise<void> {
  if (!signedIntent(id)) {
    await send([intentFrame(id, payload)])
    return
  }
  const token = await mint(id, payload)
  if (!token) return
  await send([intentFrame(id, payload, token)])
}

/**
 * What an intent is sent, when the markup has not spelled it out: an explicit `data-weft-payload`,
 * then a form's fields, then the control's own `name`/value plus ancestor data attributes — how a
 * row identifies itself with no mapping declared. `data-weft-*` is never sent.
 */
function payloadOf(element: HTMLElement): unknown {
  const raw = element.dataset.weftPayload
  if (raw) return JSON.parse(raw)

  // Merged in increasing precedence: row, then form, then control. Taking only the first source
  // is how a control with no `name` once sent an empty payload.
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

/** Every element that names an intent, wired once. A `<form>` naming one keeps working with no
 * JavaScript at all; this only upgrades it. */
/** The intent a form's action names: the name rather than the id, because the id is not in the document. */
function intentNamed(action: string): string {
  try {
    const path = new URL(action, window.location.href).pathname
    return decodeURIComponent(path.split('/_weft/i/')[1] ?? '')
  } catch {
    return ''
  }
}

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
        void fire(id, payloadOf(element))
      })
      continue
    }
    element.addEventListener('click', () => {
      void fire(id, payloadOf(element))
    })
  }
}

// ── controls ─────────────────────────────────────────────────────────────────────────

/**
 * A control on a server-rendered page is a query parameter. `data-weft-control="rows"` says which
 * parameter an input owns; `data-weft-apply` says "get the page to agree with it" — a refresh on a
 * live region, a navigation otherwise.
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
 * Where you were, across a navigation the framework caused. The browser only restores scroll on
 * back/forward, so the position is recorded against the path and put back on the way in, in
 * `sessionStorage`. See `spec/client/navigation.md`.
 */
const SCROLL_KEY = 'weft:scroll'

/**
 * Where the reader is, recorded for a load that is about to happen somewhere else. Against a path
 * rather than a history entry: the page that reads it is a new document.
 */
function handOff(path: string, y: number): void {
  try {
    sessionStorage.setItem(`${SCROLL_KEY}:${path}`, String(Math.round(y)))
  } catch {
    // A tab with site data blocked. The navigation is still correct; it starts at the top.
  }
}

/** A browser navigation this runtime is about to cause that lands at the top. See `SCROLL_PRELUDE`. */
let departingToTop = false

function rememberScroll(): void {
  if (departingToTop) return
  // A zero is indistinguishable from nothing, and would overwrite a position something else
  // deliberately handed to the load about to happen.
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

  // Synchronously, not a frame later: this module is deferred, so the document already has its
  // height. `instant` because smooth-scrolling CSS would otherwise animate the restore.
  const land = (): void => window.scrollTo({ top: y, behavior: 'instant' as ScrollBehavior })
  land()
  // A late font or an image with no dimensions can grow the document after this. Skipped if the
  // reader has since scrolled themselves.
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
 * Whether this page can be brought up to date in place rather than reloaded. Wiring is fine — a
 * listener rebinds — but a signal or a live region holds state a reload would lose silently.
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
 * The same page, brought up to date, without leaving it: a control-triggered reload or a form's 303
 * would otherwise repaint from the top and lose the scroll position. Every failure falls back to a
 * real navigation.
 */
async function swapFrom(html: string, url: string): Promise<boolean> {
  const next = parseDocument(html)
  if (!next) return false
  if (!swappable(document) || !swappable(next)) return false
  // Where the reader is: holes are replaced one at a time, so the document is momentarily shorter
  // and the browser clamps the scroll, then the content comes back and the position does not.
  const y = Math.round(scrollY)

  // The layout's `<slot>` elements, not the region wrappers inside them: cutting one level in
  // would leave the old adopt payload beside new nodes.
  const holes = [...document.querySelectorAll('slot[name]')]
  if (!holes.length) return false
  const incoming = holes.map((hole) => next.querySelector(`slot[name="${hole.getAttribute('name') ?? ''}"]`))
  // A hole this document has and the answer does not means the two are not the same shape.
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
 * A form that posts to an intent, upgraded when there is something to upgrade it with. With no
 * JavaScript it posts and a 303 brings you back; with it the same post is a `fetch` swapped in
 * place. Captured at the document, so a region replaced by a delta brings new forms already wired.
 */
function upgradeIntentForms(): void {
  document.addEventListener(
    'submit',
    (event) => {
      const form = event.target as HTMLFormElement | null
      if (!form?.action.includes('/_weft/i/')) return
      if (!swappable(document)) {
        // `swappable` false means a document swap would replace bound nodes — a fact about the
        // answer, not the request. A form naming an intent in its `action` carries no
        // `data-weft-intent` and was never wired, so on a live page every intent was a full page
        // load until this dispatched it over the channel instead.
        const id = intentIds[intentNamed(form.action)]
        if (!id) {
          // Nothing to dispatch with: record the position for the plain post about to happen.
          rememberScroll()
          return
        }
        event.preventDefault()
        void fire(id, payloadOf(form)).catch(() => {
          rememberScroll()
          form.submit()
        })
        return
      }
      event.preventDefault()
      void (async () => {
        const body = new URLSearchParams(new FormData(form) as unknown as Record<string, string>).toString()
        const response = await fetch(form.action, {
          method: 'POST',
          body,
          headers: {
            // `text/html`: a successful intent answers with a 303 back to the page. `x-weft-fetch`
            // is how a refusal comes back machine-readable — see `refusalPage` in `serve.ts`.
            accept: 'text/html',
            'x-weft-fetch': '1',
            'content-type': 'application/x-www-form-urlencoded',
          },
        }).catch(() => null)
        // A refusal is answered here rather than navigated to: the answer is already in hand.
        if (response && !response.ok) {
          const failed = (await response.json().catch(() => null)) as {
            code?: string
            detail?: string
          } | null
          refused(
            failed?.code ?? `E_INTENT_HTTP_${response.status}`,
            failed?.detail ?? 'the intent was refused',
          )
          return
        }
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
  // The address bar has to agree with what the server was asked.
  window.history.replaceState(null, '', url.toString())
  await refresh(undefined, url.pathname + url.search)
}

function wireControls(): void {
  for (const node of document.querySelectorAll('[data-weft-apply]')) {
    if (wired.has(node)) continue
    wired.add(node)
    node.addEventListener('click', () => void apply())
  }
  // A range input whose value is invisible is a mystery until you let go of it.
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
 * The framework's own state, painted into whatever asks for it — every page that wanted these
 * numbers was writing the same polling loop against `window.weft` by hand.
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
      case 'known':
        element.textContent = state.known.length
          ? `${state.known.length}: ${state.known.join(' · ')}`
          : 'nothing discovered'
        break
      default:
        break
    }
  }
}

let polling = false // Started once per page load, not once per swap.

async function wireRuntimeReadouts(): Promise<void> {
  const stats = document.querySelectorAll('[data-weft-stat]')
  const resident = document.querySelectorAll('[data-weft-resident]')
  const forget = document.querySelectorAll('[data-weft-forget]')
  if (stats.length) {
    paintStats()
    // Polled rather than pushed: a subscription nobody unsubscribes from outlives its element.
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
  /**
   * What is underneath, asked rather than remembered — a binding is not fixed for the channel's
   * life: a 409 means it takes turns from there. See `spec/kernel/transport.md`.
   */
  readonly binding: 'socket' | 'stream' | 'turn'
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
 * A refresh, and the one thing it has to say first: where the client is now — a control that
 * changed the query has to re-register before it asks, or gets the old answer.
 */
async function refresh(slots?: readonly string[], at?: string): Promise<number> {
  const w = await wire()
  const names = slots?.length ? [...slots] : state.live
  if (!names.length) return 0
  // Every POST carries the current location, so setting it is the whole of re-registering.
  if (at) location_ = at
  const before = state.writes
  await w.send([{ kind: 'REFRESH', header: { s: names.join(',') } }])
  // The answer arrives on the down connection, so the writes it caused are counted there.
  await new Promise((resolve) => setTimeout(resolve, 0))
  return state.writes - before
}

/**
 * A render intent: ask the server to put a catalogue entry in a slot on this page. `REFRESH` with a
 * source named — same forms, same epoch semantics, same surgical ladder.
 */
async function render(id: string, slot: string, params: unknown = {}): Promise<number> {
  const w = await wire()
  const before = state.writes
  await w.send([
    { kind: 'REFRESH', header: { s: slot, r: id }, body: new TextEncoder().encode(JSON.stringify(params)) },
  ])
  await new Promise((resolve) => setTimeout(resolve, 0))
  return state.writes - before
}

function upFrames(frames: readonly ChannelFrame[]): Frame[] {
  return frames.map((f) => warpFrame(f.kind as FrameKind, f.header, f.body, true)) as Frame[]
}

function encodeUp(frames: readonly ChannelFrame[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encodeStream(upFrames(frames)))
}

/**
 * The same frames without a preamble, for a binding where one has already been sent. A socket is
 * one stream for its whole life; repeating the preamble per message once corrupted every frame
 * after the first.
 */
function encodeUpContinued(frames: readonly ChannelFrame[]): Uint8Array<ArrayBuffer> {
  const parts = upFrames(frames).map(encodeBinaryFrame)
  return new Uint8Array(parts.reduce<Uint8Array>((acc, p) => concatBytes(acc, p), new Uint8Array(0)))
}

/** What this client is, as a header. Shared: a turn declares it every request, a held binding once. */
function residentHeader(transport: string): Record<string, string> {
  return {
    warp: WARP_VERSION,
    ir: document.documentElement.dataset.weftIr ?? '2.4.0',
    forms: 'html,delta,patch',
    transport,
  }
}

/** Where the client last told the server it is. A refresh re-registers this before it asks. */
let location_ = ''

/**
 * The answer to a route this client asked to stage. Settled here because the answer arrives on the
 * down connection, applied by the reader loop; the asking side waits in `waiting`.
 */
const routeNav = navFrames((nav) => {
  log('down', `NAV ${nav.at} ${nav.form}${nav.why ? ` — ${nav.why}` : ''}`)
  const settle = nav.epoch ? waiting.get(nav.epoch) : undefined
  if (!nav.epoch || !settle) return
  if (nav.form !== 'slots') {
    waiting.delete(nav.epoch)
    settle(null)
    return
  }
  pending.set(nav.epoch, nav)
})

/**
 * The shell's exposed values, arriving: one frame with a body when the channel opens, one small
 * frame per name after a write. See `spec/kernel/composition.md`.
 */
const routeExposed = exposedFrames(exposure, (line) => log('down', line))

/**
 * A region refreshed as a patch: the rung between a delta and being replaced whole. Nothing is
 * re-adopted afterwards — the nodes the bindings point at are the nodes that were written. See
 * `spec/kernel/surgical.md`.
 */
const routePatch = patchFrames(
  (slot) => {
    const region = regionsHeld.find((held) => held.slot === slot)
    const root = document.querySelector(`[data-weft-slot="${slot}"]`)
    return region && root ? { root, base: region.base } : undefined
  },
  (slot, writes, next) => {
    const region = regionsHeld.find((held) => held.slot === slot)
    if (region) region.base = next
    log('down', `PATCH ${slot} — ${writes} write(s)`)
  },
)

/**
 * The plan, extended: preload the stylesheet of a route the reader is likely to go to, and stage
 * at most two of what the profile says readers of this page go next.
 */
const routePlan = planFrames(known, (arrival) => {
  log('down', `PLAN ${arrival.prefix || '(this page)'} ${arrival.routes.length} route(s)`)
  state.known = known.patterns
  const here_ = known.route(window.location.href, window.location.href)
  for (const route of arrival.routes) {
    if (route.css && route.pattern !== here_?.pattern) preloadStylesheet(route.css)
  }
  // Only for the frame about this page: a prefix asked about is a hint, not a fetch list.
  if (arrival.prefix && here_ && arrival.prefix !== here_.pattern) return
  for (const pattern of (here_?.next ?? []).slice(0, 2)) {
    if (pattern.includes(':') || pattern.includes('*')) continue
    // Acted on once per page: a `PLAN` arrives on every re-declaration, which on a turn is every
    // request, and hearing the same hint twice is not new information.
    const key = stagingKey(pattern, window.location.href)
    if (hinted.has(key)) continue
    hinted.add(key)
    void routes.stage(key).then(syncStaged)
  }
})

/** Hints already acted on, so a repeated `PLAN` is not a repeated fetch. Cleared on a commit. */
const hinted = new Set<string>()

/**
 * The plan, on a page that would otherwise never ask for it: a `PLAN` arrives unasked only when a
 * channel opens, which on a mostly-reading site was most pages, never. After the page, since it is
 * speculation, on the same gate the three staging signals are on.
 */
const LEARN_MS = 200

function learn(): void {
  if (!speculating()) return
  window.setTimeout(() => {
    void wire().catch((error: unknown) => log('down', `no plan: ${String(error)}`))
  }, LEARN_MS)
}

/**
 * Ask about a subtree of the plan: the design's `router.discover('/checkout/*')`. Once per prefix —
 * a description rather than a render, unlike staging.
 */
async function discover(prefix: string): Promise<string[]> {
  if (known.asked(prefix)) return known.patterns
  known.ask(prefix)
  if (!window.__weftChannel) return known.patterns
  const w = await wire()
  await w.send([discoverFrame(prefix) as ChannelFrame])
  // The answer arrives on the down connection and lands in `known`.
  await new Promise((resolve) => setTimeout(resolve, 0))
  return known.patterns
}

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
    // Composed rather than one switch: a frame kind belongs to the capability that introduced it,
    // so a page that does neither `NAV` nor `PLAN` carries neither.
    onFrame: (frame, applied) => {
      // The high-water mark, read off the frame the channel already routed. Here rather than in
      // the channel client: a page on a socket is never told twice.
      if (frame.kind === 'STALE') since = Math.max(since, Number(frame.header.at ?? 0))
      routeNav(frame, applied)
      routePlan(frame)
      routeExposed(frame)
      routePatch(frame, applied)
    },
    onAck: (ack) => {
      log('down', `ACK ${ack.intent} ok=${ack.ok}${ack.code ? ` ${ack.code}` : ''}`)
      if (!ack.ok) refused(ack.code ?? 'E_INTENT_FAILED', ack.detail ?? 'the intent was refused')
    },
    onRedirect: (to) => window.location.assign(to),
    // A region sent as markup: the old bindings point at nodes no longer in the document, so it
    // is adopted again and its controls rewired. See `spec/client/adoption.md`.
    onHtml: (slot, html, showing) => {
      const target = document.querySelector(`[data-weft-slot="${slot}"]`)
      if (!target) return
      target.innerHTML = html
      void (async () => {
        // The outer entry keeps the base it is now showing; the regions inside it are replaced
        // by whatever the new markup declares.
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

  // One socket if the browser and server can have one, two fetches if they cannot. Not a fallback
  // for old browsers — for a socket that does not survive the path, found only by trying. See
  // `spec/kernel/transport.md`.
  // A deployment that cannot hold a downstream never gets one attempted: trying anyway makes an
  // unavailable channel look like a broken one.
  const holds = window.__weftHold !== false
  const socketUrl = `${base.replace(/^http/, 'ws')}?c=${id}&at=${encodeURIComponent(location_)}`
  const socket = holds ? await connect(socketUrl) : null
  let turning = !holds // Set once the half-duplex path proves it cannot answer, and never unset.
  let since = 0 // The most recent invalidation told about, sent back — see `spec/kernel/transport.md`.

  const query = (): string => `c=${id}&at=${encodeURIComponent(location_)}${since ? `&since=${since}` : ''}`

  /**
   * One turn: what the client holds, what it is showing, and what it wants, in one request — a
   * turn cannot assume the server still remembers. See `spec/kernel/transport.md`.
   */
  const takeTurn = async (frames: readonly ChannelFrame[]): Promise<void> => {
    const declared: ChannelFrame[] = [
      { kind: 'RESIDENT', header: residentHeader('turn') },
      { kind: 'HELD', header: client.held({ only: true }) },
      ...frames,
    ]
    const response = await fetch(`${base}/turn?${query()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/warp' },
      body: encodeUp(declared),
    })
    if (!response.ok) {
      log('down', `turn refused ${response.status}: ${(await response.text()).trim().slice(0, 160)}`)
      return
    }
    // Its own decoder: every turn is its own stream and carries its own preamble.
    await arrived(new Uint8Array(await response.arrayBuffer()), createBinaryDecoder({ expect: 'down' }))
  }

  /** Whether this socket has announced its version. One stream, so exactly one preamble. */
  let announced = false

  const post = async (frames: readonly ChannelFrame[]): Promise<void> => {
    for (const f of frames) log('up', describe(f))
    if (socket) {
      socket.send((announced ? encodeUpContinued(frames) : encodeUp(frames)) as Uint8Array<ArrayBuffer>)
      announced = true
      return
    }
    if (turning) {
      await takeTurn(frames)
      return
    }
    const response = await fetch(`${base}?${query()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/warp' },
      body: encodeUp(frames),
    })
    if (response.status === 202) return
    log('down', `POST refused ${response.status}: ${(await response.text()).trim().slice(0, 160)}`)
    // 409: the downstream this POST was to be answered on is gone. Switches to turns rather than
    // reopening, which on the wrong instance would produce it again.
    if (response.status === 409) {
      if (turning) return
      turning = true
      log('down', 'no downstream to answer on: this channel is taking turns from here')
      await takeTurn(frames)
    }
  }

  const decoder = createBinaryDecoder({ expect: 'down' })
  // Aborted on the way out: an abandoned chunked response reports as
  // ERR_INCOMPLETE_CHUNKED_ENCODING otherwise, which looks like a server fault.
  const leaving = new AbortController()
  window.addEventListener('pagehide', () => {
    leaving.abort()
    socket?.close()
  })
  const down = socket || turning ? null : await fetch(`${base}?${query()}`, { signal: leaving.signal })
  state.connected = true

  /**
   * Bytes arriving, from whichever direction they came. The decoder is length-prefixed either way,
   * so the routing below cannot depend on which transport is underneath it.
   */
  const arrived = async (value: Uint8Array, dec = decoder): Promise<void> => {
    const frames = dec.push(value).filter((f) => f.kind !== 'UNKNOWN') as ChannelFrame[]
    for (const f of frames) log('down', describe(f))
    const applied = await client.apply(frames)
    state.writes += applied.writes
    // A staged route becomes staged when the last of its regions lands. Checked after the whole
    // batch: cheaper, and correct when they do not all arrive together.
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
    // A STALE frame is an invitation rather than an instruction.
    if (applied.stale.length) await post([{ kind: 'REFRESH', header: { s: applied.stale.join(',') } }])
  }

  if (turning) {
    // Nothing to read: `takeTurn` has already handed a turn's frames to `arrived`.
  } else if (socket) {
    socket.addEventListener('message', (event: MessageEvent) => {
      void (async () => {
        const data = event.data as ArrayBuffer | Blob | string
        const bytes =
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : typeof data === 'string'
              ? new TextEncoder().encode(data)
              : new Uint8Array(await (data as Blob).arrayBuffer())
        await arrived(bytes)
      })().catch((error: unknown) => log('down', `frame dropped: ${String(error)}`))
    })
    // A socket that closes is a channel that is gone: the next use reopens, with the same id.
    socket.addEventListener('close', () => {
      opening = null
      state.connected = false
      log('down', 'socket closed')
    })
  } else {
    void (async () => {
      const reader = (down as Response).body as ReadableStream<Uint8Array>
      const stream = reader.getReader()
      for (;;) {
        const { done, value } = await stream.read()
        if (done) break
        if (value) await arrived(value)
      }
    })().catch((error: unknown) => log('down', `reader stopped: ${String(error)}`))
  }

  /**
   * The opening handshake — and the one a turn has to take on purpose, or the frames the server
   * sends unasked when a channel opens never arrive on a page that sends nothing. See
   * `spec/kernel/transport.md`.
   */
  if (!turning) {
    await post([{ kind: 'RESIDENT', header: residentHeader(socket ? 'socket' : 'stream') }])
    if (regionsHeld.length) await post([{ kind: 'HELD', header: client.held() }])
  } else {
    await takeTurn([])
  }

  return {
    send: post,
    client,
    get binding() {
      return socket ? 'socket' : turning ? 'turn' : 'stream'
    },
  }
}

/**
 * A socket, or nothing, and never a rejected promise: `WebSocket` reports failure as an event,
 * late. No retry — a deployment where the upgrade fails will fail it again.
 */
function connect(url: string): Promise<WebSocket | null> {
  if (typeof WebSocket === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    let settled = false
    const done = (value: WebSocket | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      const socket = new WebSocket(url)
      socket.binaryType = 'arraybuffer'
      socket.addEventListener('open', () => done(socket), { once: true })
      socket.addEventListener('error', () => done(null), { once: true })
      socket.addEventListener('close', () => done(null), { once: true })
    } catch {
      done(null)
    }
  })
}

// ── navigation ───────────────────────────────────────────────────────────────────────

/**
 * A page you have not gone to yet, fetched and painting nothing. `createStaging` keys an epoch by
 * URL: fetched on hover, parsed, held; the click commits it as a DOM swap. See `spec/client/navigation.md`.
 */
/**
 * A route held and unpainted, in one of two forms: a **document**, fetched over HTTP, or a **page
 * of regions** — `WARM at=`, answered by `NAV` — only when the target shares this page's shell.
 */
interface StagedPage {
  document: Document
  /** Where the answer came from. A guard's redirect is a decision about the URL, so it wins. */
  url: string
}

interface StagedRegions {
  /** The epoch its regions are held in. Painting commits it. */
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

const HOVER_MS = 65 // Below this a pointer crossing a nav on its way elsewhere prefetches the lot.

/** Answers waiting on the down connection, by epoch — the frame router settles them, not the asker. */
let staging: Epochs | null = null

const waiting = new Map<string, (held: Held | null) => void>()
/** Routes whose `NAV` has arrived and whose regions have not all landed yet. A partial epoch is
 * never committed. */
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
 * The route, asked for over the channel first and over HTTP otherwise. The channel is tried only
 * when one is already open — opening one to stage a route nobody clicked pays for speculation
 * twice.
 */
const routes = createStaging<Held>({
  /** A staged route that is dropped gives its epoch back, or it is memory held for a page nobody is going to. */
  release: (held: Held) => {
    if (held.kind === 'regions') staging?.discard(held.regions.epoch)
  },
  load: async (url, abort) => {
    const open_ = opening
    if (!open_ || !window.__weftChannel) return stageDocument(url, abort)
    // A route the server already said uses a different document is fetched as a document, with
    // no `WARM` — the server's own answer, given earlier for a whole subtree.
    const plan = known.route(url, window.location.href)
    if (plan && !plan.shared) {
      log('up', `no WARM for ${new URL(url).pathname}: a different shell, from the plan`)
      return stageDocument(url, abort)
    }

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
    // Either the server sent us to the document, or the regions did not all arrive — same fallback.
    return stageDocument(url, abort)
  },
})

/** Routes whose answer is *held*. `routes.open` includes ones still in flight, which are not ready. */
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

/** Whether this page speculates about anything at all — the document's switch and the network,
 * asked by all three staging signals in one place. */
function speculating(): boolean {
  if (document.documentElement.dataset.weftPrefetch === 'off') return false
  const connection = (navigator as { connection?: { saveData?: boolean; effectiveType?: string } }).connection
  if (connection?.saveData) return false
  return !(connection?.effectiveType && connection.effectiveType.includes('2g'))
}

/**
 * Whether a link is worth fetching before it is clicked. A prefetch is a render the server
 * performs for a page that may never be asked for, so `data-weft-prefetch="off"`, save-data and 2G
 * all refuse it. The click still works either way.
 */
function prefetchable(link: HTMLAnchorElement): boolean {
  if (!navigable(linkFacts(link), window.location.href)) return false
  if (link.dataset.weftPrefetch === 'off') return false
  if (!speculating()) return false
  // `stage: false` means readers of this page were told about that route and did not follow it.
  // Checked here so all three staging signals share the decision. See `spec/plan/profile.md`.
  if (known.route(link.href, window.location.href)?.stage === false) return false
  return !samePage(new URL(link.href, window.location.href))
}

function parseDocument(html: string): Document | null {
  let next: Document
  try {
    next = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return null
  }
  // An out-of-order answer arrives unfilled: each region is a `<template data-w="…">` after the
  // shell, normally moved by the inline filler script — which a parsed document never runs. So the
  // same move is made here, against the inert document.
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
 * The next page's stylesheet, fetched while staged and applied to nothing: `preload` rather than
 * `stylesheet`, or a second page's rules would apply to the one being looked at.
 */
function preloadStylesheet(href: string): void {
  const absolute = new URL(href, window.location.href).href
  for (const node of document.head.querySelectorAll('link')) {
    if ((node as HTMLLinkElement).href === absolute) return
  }
  const link = document.createElement('link')
  link.rel = 'preload'
  link.as = 'style'
  link.href = href
  document.head.append(link)
}

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
  // Awaited: painting the next page with the last one's stylesheet is the flash this avoids. The
  // bytes are already cached, so this waits on a task rather than a round trip.
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
 * Put the reader back at a position, and again on the next frame if it did not take: the document
 * has just been rewritten and the browser's own clamp lands after this runs.
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
 * Where the client is now, and what it is holding there — a navigation that did not re-register
 * would be answered from the old page. `only` says the left page stops being refreshed for.
 */
async function rebind(url: URL): Promise<void> {
  // Set before anything can be sent: a channel opened later registers the right path.
  location_ = url.pathname + url.search
  const held = opening
  if (!held) {
    if (liveRegions) await wire()
    else learn()
    return
  }
  const w = await held
  // `RESIDENT` again: a re-declaration gets the frames the server sends unasked on open — without
  // it the plan and `next` hints stayed the previous page's. A turn already re-declares every
  // request.
  await w.send([
    ...(w.binding === 'turn' ? [] : [{ kind: 'RESIDENT', header: residentHeader(w.binding) }]),
    { kind: 'HELD', header: w.client.held({ only: true }) },
  ])
}

/**
 * A route staged as regions, painted. The commit is the epoch: every region flips together. What
 * happens around it is the same list a document swap has, minus the document.
 */
async function commitRegions(staged: StagedRegions, mode: 'push' | 'restore', y: number): Promise<number> {
  const url = new URL(staged.url, window.location.href)
  hinted.clear() // A hint is about the page it was given on.
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
  announceNavigation(url, 'regions')
  await rebind(url)
  // What the server's numbers say this reader is likely to want next, once each.
  for (const route of staged.next.slice(0, 2)) {
    const key = stagingKey(route, window.location.href)
    if (hinted.has(key)) continue
    hinted.add(key)
    void routes.stage(key).then(syncStaged)
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
  hinted.clear()

  await applyStyles(next)
  syncHead(next)
  syncAttributes(document.documentElement, next.documentElement)

  if (mode === 'push') {
    // Against the entry being left: the only entry that can hold it.
    const state_ = (window.history.state ?? {}) as Record<string, unknown>
    window.history.replaceState({ ...state_, weftY: Math.round(scrollY) }, '')
  }

  syncAttributes(document.body, next.body)
  document.body.replaceChildren(...document.importNode(next.body, true).childNodes)
  if (mode === 'push') window.history.pushState({ weftY: 0 }, '', url.href)
  here = url

  // The last page's bindings point at nodes no longer in the document; a signal with no page is
  // state with no owner.
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
  announceNavigation(url, 'document')
  // After the announcement: what the click bought is on screen and interactive, not a round trip.
  await rebind(url)
  return painted
}

/**
 * A click is answered here only when the answer is already in hand. Waiting for the hover's fetch
 * would be worse than the browser: a document response streams and a `fetch` does not, so the
 * reader would sit with no spinner. Staged is instant; not staged is a real navigation.
 */
/** Taken over lazily, only once the framework really navigates. See `spec/client/navigation.md`. */
function takeOverScroll(): void {
  try {
    if (window.history.scrollRestoration !== 'manual') window.history.scrollRestoration = 'manual'
  } catch {
    // An engine without the property restores its own way; the re-land still runs.
  }
}

/**
 * How a `go` ended: `cold` means nothing was staged; `stale` means a newer navigation overtook this
 * one, and it must neither paint nor fall back to loading the document.
 */
type Went = 'painted' | 'cold' | 'stale'

/**
 * Which navigation is the current one. A staged route is claimed with no deadline, so a click on a
 * slow route followed by others could paint last — this ticket is what lets a navigation notice it
 * was superseded. Bumped by `go`, not by staging.
 */
let navSeq = 0

async function go(href: string, mode: 'push' | 'restore', y = 0): Promise<Went> {
  const mine = ++navSeq
  takeOverScroll()
  const url = new URL(href, window.location.href)
  const key = stagingKey(url.href, window.location.href)
  const started = performance.now()

  /**
   * A route being staged right now is claimed, not thrown away: a click at normal speed lands in
   * the window between hover-fetch and answer, and discarding it meant every click was a full
   * navigation. No deadline on the wait — waiting cannot cost more than not waiting, since the
   * fallback re-fetches the same URL anyway.
   */
  const stageState = routes.state(key)
  if (stageState === 'none' || stageState === 'failed') {
    routes.discard(key)
    syncStaged()
    // Back and forward cannot be handed to the browser the way a cold click can: the address bar
    // has already moved, and `location.reload()` throws away every module and region this page
    // holds. So a traversal stages the route and waits for it — same bytes, and the runtime
    // survives.
    if (mode !== 'restore') {
      state.nav = { ...state.nav, cold: state.nav.cold + 1 }
      return 'cold'
    }
    await routes.stage(key)
    syncStaged()
    if (mine !== navSeq) return 'stale'
    if (routes.state(key) !== 'ready') {
      state.nav = { ...state.nav, cold: state.nav.cold + 1 }
      return 'cold'
    }
  }
  const claimed = await routes.claim(key)
  syncStaged()
  // Checked between waiting and painting: the claim above is where a newer navigation overtakes
  // this one. Anything staged stays staged.
  if (mine !== navSeq) return 'stale'
  if (!claimed.value) {
    state.nav = { ...state.nav, cold: state.nav.cold + 1 }
    return 'cold'
  }
  const held = claimed.value
  const painted =
    held.kind === 'regions'
      ? await commitRegions(held.regions, mode, y)
      : await commitPage(held.page, mode, y)
  if (!painted) return 'cold'
  state.nav = { ...state.nav, staged: state.nav.staged + 1, lastMs: Math.round(painted - started) }
  log('up', `NAV ${url.pathname}${url.search} ${state.nav.lastMs}ms`)
  return 'painted'
}

/**
 * `weft:navigated`, on the document, after a route change has painted — the one thing an
 * application's `client.ts` cannot work out for itself, since a staged navigation replaces regions
 * with no reload.
 *
 * **Fired from inside the commit, in the same task as the paint.** It used to fire from `go`, after
 * the commit's own rebind POST — so the listener ran a round trip after the new document was on
 * screen: the theme reverted to the server's for the length of a request, and a flag-gated control
 * vanished and came back. Nothing that paints the page may wait for the network. See
 * `spec/client/navigation.md`.
 */
function announceNavigation(url: URL, kind: 'regions' | 'document'): void {
  document.dispatchEvent(
    new CustomEvent('weft:navigated', {
      detail: { url: url.href, pathname: url.pathname, search: url.search, kind },
    }),
  )
}

/**
 * Where a route change lands, and who decides: the link, then the application's config, then
 * `top`. Back and forward ignore both. See `spec/client/navigation.md`.
 */
function scrollFor(link?: HTMLAnchorElement | null): 'top' | 'preserve' {
  const asked = link?.dataset.weftScroll ?? window.__weftScroll
  return asked === 'preserve' ? 'preserve' : 'top'
}

/**
 * Where a GET submit lands: the opposite default to a link's. A GET form re-renders the page it is
 * already on, so `preserve` by default. Only the form's own attribute is read — `__weftScroll` is
 * the link answer and once made every form inherit a link's decision.
 */
function scrollForForm(form: HTMLFormElement): 'top' | 'preserve' {
  return form.dataset.weftScroll === 'top' ? 'top' : 'preserve'
}

async function navigate(href: string, scroll: 'top' | 'preserve' = scrollFor()): Promise<boolean> {
  const y = scroll === 'preserve' ? Math.round(scrollY) : 0
  const went = await go(href, 'push', y)
  if (went === 'painted') {
    // Swapped in place: no document is leaving, so nothing should be recorded on its behalf.
    departingToTop = false
    return true
  }
  // Overtaken: `location.assign` below is right for a never-staged route and wrong here — the
  // reader asked for somewhere else since.
  if (went === 'stale') return false
  departingToTop = y === 0
  // `preserve` has to mean the same thing for a real navigation, or keeping the reader's place
  // depended on whether they happened to hover long enough first.
  const url = new URL(href, window.location.href)
  if (y > 0) handOff(url.pathname, y)
  window.location.assign(url.href)
  return false
}

/**
 * A link the reader has been looking at — the strongest mobile signal there is, needing no
 * gesture. Every link, not only the ones inside a region: excluding the chrome meant the links a
 * reader most often takes were never staged. Held down by dwell time, `VIEWPORT_MAX`, and the plan.
 * `data-weft-prefetch="hover"` opts out of this signal alone; `"off"` opts out of all. See
 * `spec/client/navigation.md`.
 */
const VIEWPORT_DWELL_MS = 300
const VIEWPORT_MAX = 2

/** Whether the viewport is a staging signal here. On by default; `"hover"` is the opt-out. */
function watched(link: HTMLAnchorElement): boolean {
  if (document.documentElement.dataset.weftPrefetch === 'hover') return false
  return link.dataset.weftPrefetch !== 'hover'
}

function watchViewport(): void {
  if (typeof IntersectionObserver === 'undefined') return
  // How many routes this signal is holding, not how many it has ever staged — a counter that only
  // went up spent its two on the first screenful and did nothing for the rest of the page's life.
  const mine = new Set<string>()
  const holding = (): number => {
    for (const key of mine) if (routes.state(key) === 'none') mine.delete(key)
    return mine.size
  }
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
        if (dwelling.has(link) || holding() >= VIEWPORT_MAX) continue
        dwelling.set(
          link,
          window.setTimeout(() => {
            dwelling.delete(link)
            if (holding() >= VIEWPORT_MAX || !prefetchable(link) || !watched(link)) return
            const key = stagingKey(link.href, window.location.href)
            mine.add(key)
            observer.unobserve(link)
            void routes.stage(key).then(syncStaged)
          }, VIEWPORT_DWELL_MS),
        )
      }
    },
    { rootMargin: '0px' },
  )

  const observe = (): void => {
    for (const node of document.querySelectorAll('a[href]')) {
      const link = node as HTMLAnchorElement
      if (prefetchable(link) && watched(link)) observer.observe(link)
    }
  }
  observe()
  // A region or a commit brings new links, and an observer only knows the nodes it was given, so
  // it is given the whole document again.
  observed = () => {
    observer.disconnect()
    dwelling.clear()
    observe()
  }
}

/** Re-observed after a swap. Set by `watchViewport`; a page without one does nothing. */
let observed: (() => void) | null = null

/**
 * The browser's own heuristics, told which links are worth them — the one mechanism here that is
 * not this framework's, using signals it has and we do not. A layer over the two above, not a
 * replacement. See `spec/client/navigation.md`.
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
 * Links, answered by the framework only where the markup says it may. Delegated at the document:
 * a listener attached per link is one that will be missed once a delta brings new ones.
 */
function wireNavigation(): void {
  // Recorded only once this runtime owns scroll. See `spec/client/navigation.md`.
  window.addEventListener('pagehide', () => {
    try {
      if (window.history.scrollRestoration !== 'manual') return
    } catch {
      return
    }
    rememberScroll()
  })

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
      // Asked again on the way out: clicking a link focuses it, so by the time this fires the
      // page it names may already be the page you are on.
      const url = new URL(href, window.location.href)
      if (samePage(url)) return
      void routes.stage(stagingKey(url.href, window.location.href)).then(syncStaged)
    }, HOVER_MS)
  }

  /**
   * Staged now, with no hover intent to wait for: `pointerdown` fires on finger-down, the only
   * warning a phone gives, and a press is a decision with nothing to disambiguate.
   */
  const now_ = (event: Event): void => {
    const link = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!link || !prefetchable(link)) return
    cancel()
    void routes.stage(stagingKey(link.href, window.location.href)).then(syncStaged)
  }

  document.addEventListener('pointerover', consider, { passive: true })
  document.addEventListener('pointerout', cancel, { passive: true })
  // A keyboard reader never hovers either; focus is the same signal by another name.
  document.addEventListener('focusin', consider, { passive: true })
  document.addEventListener('pointerdown', now_, { passive: true })
  watchViewport()
  speculate()

  // A `method="get"` submit means what a link click means. A POST is an intent —
  // `upgradeIntentForms` already has it.
  document.addEventListener('submit', (event) => {
    if (event.defaultPrevented) return
    const form = event.target as HTMLFormElement | null
    if (!form || (form.method || 'get').toLowerCase() !== 'get') return
    if (!swappable(document)) return
    const action = form.getAttribute('action') ?? window.location.pathname
    let url: URL
    try {
      url = new URL(action, window.location.href)
    } catch {
      return
    }
    // The form's own fields decide the query, as the browser would have done.
    url.search = new URLSearchParams(new FormData(form) as unknown as Record<string, string>).toString()
    if (!navigable({ href: url.href }, window.location.href)) return
    event.preventDefault()
    // The reader's place is kept: a GET submit re-renders the page they are reading rather than
    // taking them somewhere new.
    void navigate(url.href, scrollForForm(form))
  })

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented) return
    const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
    if (!plainClick({ modified, button: event.button })) return
    const link = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!link || !navigable(linkFacts(link), window.location.href)) return
    const url = new URL(link.href, window.location.href)
    // The page already on screen: handing this to the browser reloaded the document whenever a
    // reader clicked the section they were already reading.
    if (samePage(url)) {
      event.preventDefault()
      return
    }
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
      // `stale` returns too: a newer traversal is in charge, and reloading would fight it.
      if ((await go(url.href, 'restore', y)) !== 'cold') return
      // Nothing staged: loaded streamed, the way the first visit was. Written even when zero, so an
      // earlier position cannot be restored over a page left at the top — boot removes the key
      // it reads regardless.
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
  // A page with a live region wants the channel now; every other page opens one shortly after.
  if (regionsHeld.length && liveRegions) await wire()
  else learn()
  // The application's own client code, last: loaded rather than bundled, since there is no build step.
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
