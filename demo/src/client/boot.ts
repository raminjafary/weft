import { adopt } from '/runtime/adopt.ts'
import { signal, computed, type Readable } from '/runtime/signal.ts'
import { createChannelClient, type ChannelFrame, type Region } from '/runtime/channel.ts'
import { createEpochs } from '/runtime/epoch.ts'
import { digest, openResident } from '/runtime/resident.ts'
import type { ClientTemplate } from '/runtime/template.ts'
import { createBinaryDecoder, encodeStream } from '/warp/codec.ts'
import { frame as warpFrame, type Frame, type FrameKind } from '/warp/frames.ts'

/**
 * The demo's client. It is the real runtime plus wiring, and it is served as TypeScript with the
 * types stripped by Node — so the file you are reading is the file that is running.
 *
 * Three jobs, and nothing else. Adopt whatever the page said is adoptable. Wire the controls,
 * which on a server-rendered station means putting them in the query string and reloading. And on
 * the pages that have one, open a channel and hand arriving frames to the runtime's own frame
 * router, which is the part that has to be the real thing.
 */
declare global {
  interface Window {
    __weftDemo?: DemoState
  }
}

interface DemoState {
  frames: { dir: 'up' | 'down'; text: string }[]
  writes: number
  connected: boolean
  /** How far boot got. A silent failure in an async boot is indistinguishable from a page with no script. */
  stage: string
  regions: number
}

const state: DemoState = { frames: [], writes: 0, connected: false, stage: 'loaded', regions: 0 }
window.__weftDemo = state

// ── controls ─────────────────────────────────────────────────────────────────────────

/**
 * A control on a server-rendered page is a query parameter. That is not a limitation being worked
 * around: the station reads it with `ctx.query()`, so the control lands in the station's own cache
 * key, which is the thing the cache-keys station is about.
 */
const CONTROL_KEYS: Record<string, string> = {
  'delta-clients': 'clients',
  'form-scenario': 'scenario',
  'effects-fragment': 'fragment',
  'key-currency': 'currency',
  'key-tier': 'tier',
  'key-sid': 'sid',
  'route-path': 'path',
  'wave-link': 'link',
  'budget-ms': 'budget',
  'budget-cost': 'cost',
  'budget-exceed': 'exceed',
  'pool-spin': 'spin',
  'pool-budget': 'budget',
  'pool-where': 'where',
  'inc-rows': 'rows',
  'inc-every': 'every',
  'inc-reorder': 'reorder',
  'neg-ir': 'ir',
  'neg-warp': 'warp',
  'neg-transport': 'transport',
  'neg-dsd': 'dsd',
  'warp-visit': 'visit',
  'esc-value': 'value',
  'stamp-clients': 'clients',
  'stamp-cost': 'cost',
  'stamp-lease': 'lease',
  'feed-rows': 'rows',
  'dash-slow': 'slow',
  'race-slow': 'slow',
  'race-fast': 'fast',
  'race-medium': 'medium',
  'order-order': 'order',
  'stream-slow': 'slow',
  'block-slow': 'slow',
  'epoch-commit': 'commit',
  'ctrl-mode': 'mode',
  'adopt-price': 'price',
  'delta-price': 'price',
}

function reloadWithControls(): void {
  const url = new URL(window.location.href)
  for (const [id, key] of Object.entries(CONTROL_KEYS)) {
    const element = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null
    if (!element) continue
    if (element.value === '') url.searchParams.delete(key)
    else url.searchParams.set(key, element.value)
  }
  window.location.assign(url.toString())
}

function wireControls(): void {
  for (const button of document.querySelectorAll('button[id]')) {
    const id = button.id
    // Every "go" button on a station page does the same thing, because every control on a
    // server-rendered page is a query parameter.
    // `race-run` reloads the two frames in place rather than the page, so the arrival order is
    // something you can watch repeatedly without losing the sliders you set.
    if (id === 'race-run') {
      button.addEventListener('click', () => {
        for (const frame of document.querySelectorAll('.race-frames iframe')) {
          const element = frame as HTMLIFrameElement
          const url = new URL(element.src, window.location.href)
          for (const [control, key] of [
            ['race-slow', 'slow'],
            ['race-fast', 'fast'],
            ['race-medium', 'medium'],
          ] as const) {
            const input = document.getElementById(control) as HTMLInputElement | null
            if (input) url.searchParams.set(key, input.value)
          }
          url.searchParams.set('t', String(Date.now()))
          element.src = url.toString()
        }
      })
      continue
    }
    if (/-(go|run|reschedule|reload)$/.test(id)) button.addEventListener('click', reloadWithControls)
  }
  // Ranges get a live readout, so a slider is not a mystery until you press the button.
  for (const range of document.querySelectorAll('input[type=range]')) {
    const input = range as HTMLInputElement
    const label = input.closest('label')
    if (!label) continue
    const out = document.createElement('span')
    out.className = 'mono'
    out.textContent = ` ${input.value}`
    label.append(out)
    input.addEventListener('input', () => {
      out.textContent = ` ${input.value}`
    })
  }
}

// ── adoption ─────────────────────────────────────────────────────────────────────────

interface Adoptable {
  slot: string
  selector: string
  template: ClientTemplate
  base: string
  signals?: { id: string; init: unknown }[]
  values?: Record<string, unknown>
  intents?: Record<string, string>
}

/**
 * Adoption, and the part of it that is the application's job.
 *
 * `adopt` binds nodes to signals; it does not invent them. A signal's current value is application
 * state rather than template structure, so this page creates them from the declarations the server
 * shipped and hands them over. Props that a client-owned derived value reads are supplied the same
 * way — `qty * unitPrice` is recomputed in the browser, so the browser needs `unitPrice` and
 * nothing else out of the value set.
 *
 * An intent is an opaque id, so nothing here can guess what one means. What arrives is a map from
 * id to the DOM event it was written on, which is what lets the quantity box write its own signal
 * immediately rather than waiting for a round trip.
 */
const writable = new Map<string, ReturnType<typeof signal<unknown>>>()

async function adoptRegions(): Promise<Region[]> {
  const script = document.getElementById('weft-adopt')
  if (!script?.textContent) return []
  const store = await openResident()
  const resident = await store.all()
  const regions: Region[] = []

  for (const entry of JSON.parse(script.textContent) as Adoptable[]) {
    const root = document.querySelector(entry.selector)
    if (!root) continue
    resident[entry.template.version] = entry.template
    await store.put(entry.template)

    const signals: Record<string, Readable<unknown>> = {}
    for (const declaration of entry.signals ?? []) {
      const source = signal<unknown>(declaration.init)
      writable.set(declaration.id, source)
      signals[declaration.id] = source
    }
    // A constant readable. A prop is not reactive, but a derived value that reads one still has to
    // be able to read it: `bindDerived` only builds a derived value whose every reference is bound.
    for (const [id, value] of Object.entries(entry.values ?? {})) {
      signals[id] = computed(() => value)
    }

    const first = entry.signals?.[0]?.id
    const adopted = adopt({
      root,
      template: entry.template,
      resident,
      signals,
      onIntent: (intent, event) => {
        const target = event.target as HTMLInputElement | null
        if (!first || !target) return
        const next = Number(target.value)
        if (Number.isFinite(next)) writable.get(first)?.set(next)
        log('up', `intent ${intent} → ${first}=${target.value}`)
      },
    })
    regions.push({ slot: entry.slot, adopted, base: entry.base })
  }

  document.cookie = `weft-resident=${digest(Object.keys(resident))}; path=/; max-age=600; SameSite=Lax`
  return regions
}

// ── the channel ──────────────────────────────────────────────────────────────────────

function log(dir: 'up' | 'down', text: string): void {
  state.frames.push({ dir, text })
  const box = document.getElementById('frame-log')
  if (!box) return
  const line = document.createElement('div')
  line.className = dir
  line.textContent = `${dir === 'up' ? '↑' : '↓'} ${text}`
  box.prepend(line)
  while (box.childElementCount > 200) box.lastElementChild?.remove()
}

/** Outline what was just written. A delta you cannot see is indistinguishable from a page reload. */
function flash(target: Element | null): void {
  if (!target) return
  target.classList.add('wrote')
  window.setTimeout(() => target.classList.remove('wrote'), 900)
}

function describe(frame: ChannelFrame): string {
  const header = Object.entries(frame.header)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ')
  const size = frame.body ? ` (${frame.body.length} B)` : ''
  return `${frame.kind} ${header}${size}`
}

interface Wire {
  send(frames: ChannelFrame[]): Promise<void>
  client: ReturnType<typeof createChannelClient>
}

let opening: Promise<Wire> | null = null

/**
 * One channel per page, opened on demand.
 *
 * Lazily, because a page that never uses it should not pay for a long-lived connection — and
 * because the buttons that need it have to be wired whether or not it is open yet, or the first
 * click does nothing and looks broken.
 */
function wire(regions: Region[]): Promise<Wire> {
  opening ??= openChannel(regions)
  return opening
}

async function openChannel(regions: Region[]): Promise<Wire> {
  const id = `demo-${Math.random().toString(36).slice(2, 8)}`
  const epochs = createEpochs()
  const client = createChannelClient({
    epochs,
    regions: () => regions,
    onStale: (slot, reason) => log('down', `STALE ${slot} — ${reason}; asking for a delta`),
    onAck: (ack) => log('down', `ACK ${ack.intent} ok=${ack.ok}${ack.code ? ` ${ack.code}` : ''}`),
    onHtml: (slot, html) => {
      // A slot the server names may not be a marker on this page: on the showcases the refreshable
      // region *is* the body slot. Falling back to it beats silently doing nothing.
      const target =
        document.querySelector(`[data-slot="${slot}"]`) ?? document.querySelector('slot[name="body"]')
      if (target) target.innerHTML = html
      flash(target)
    },
  })

  const send = async (frames: ChannelFrame[]): Promise<void> => {
    for (const f of frames) log('up', describe(f))
    const response = await fetch(`/channel?c=${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/warp' },
      body: encodeUp(frames),
    })
    if (response.status === 202) return
    // A refused POST is a failure to report. The half-duplex bindings answer on the other
    // connection, so a POST arriving after that connection has gone is E_NO_DOWNSTREAM or
    // E_NO_SUCH_CHANNEL — which is what a reload looks like from the server's side.
    const detail = (await response.text()).trim()
    log('down', `POST refused ${response.status}: ${detail}`)
    if (response.status === 409) {
      opening = null
      state.connected = false
      const mark = document.getElementById('channel-state')
      if (mark) mark.textContent = 'closed — press again to reopen'
    }
  }

  const decoder = createBinaryDecoder({ expect: 'down' })
  // Aborted on the way out. A chunked response the browser abandons mid-stream is logged as
  // ERR_INCOMPLETE_CHUNKED_ENCODING, which looks like a server fault and is not one.
  const leaving = new AbortController()
  window.addEventListener('pagehide', () => leaving.abort(), { once: true })
  const response = await fetch(`/channel?c=${id}`, { signal: leaving.signal })
  state.connected = true
  const mark = document.getElementById('channel-state')
  if (mark) mark.textContent = `open · ${id}`

  void (async () => {
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      const frames = decoder.push(value).filter((f) => f.kind !== 'UNKNOWN') as ChannelFrame[]
      for (const f of frames) log('down', describe(f))
      const applied = await client.apply(frames)
      state.writes += applied.writes
      const readout = document.getElementById('channel-writes')
      if (readout) {
        readout.textContent = `${state.writes} DOM writes · ${applied.refused.length ? `${applied.refused.length} refused` : 'none refused'}`
      }
      // A STALE frame is an invitation, not an instruction: the client decides when to ask.
      if (applied.stale.length) await send([{ kind: 'REFRESH', header: { s: applied.stale.join(',') } }])
    }
  })().catch((error: unknown) => log('down', `reader stopped: ${String(error)}`))

  await send([
    {
      kind: 'RESIDENT',
      header: {
        warp: '1.2.0',
        ir: document.body.dataset.ir ?? '2.4.0',
        forms: 'html,delta,patch',
        transport: 'stream',
      },
    },
  ])
  if (regions.length) {
    await send([{ kind: 'HELD', header: client.held() }])
  }

  return { send, client }
}

/**
 * Frames up, encoded by the real codec.
 *
 * There is no second encoder in this file. An earlier draft hand-rolled one — eight bytes of
 * header, a little-endian length, a preamble — and a demo with its own encoder is a demo that will
 * disagree with the protocol the first time the protocol moves.
 */
function encodeUp(frames: readonly ChannelFrame[]): Uint8Array<ArrayBuffer> {
  const encoded = frames.map((f) => warpFrame(f.kind as FrameKind, f.header, f.body, true)) as Frame[]
  return new Uint8Array(encodeStream(encoded))
}

// ── boot ─────────────────────────────────────────────────────────────────────────────

/** Whatever the sku picker is showing, or the one the plain form posts. */
function sku(): string {
  return (document.getElementById('cart-sku') as HTMLSelectElement | null)?.value ?? 'OIL-2L'
}

async function residencyReadout(): Promise<void> {
  const held = document.getElementById('residency-held')
  const forget = document.getElementById('residency-forget')
  if (!held && !forget) return
  const store = await openResident()
  const all = await store.all()
  if (held) {
    held.textContent = `${Object.keys(all).length} template(s) · ${store.durable ? 'IndexedDB' : 'memory only'}`
  }
  forget?.addEventListener('click', () => {
    indexedDB.deleteDatabase('weft')
    document.cookie = 'weft-resident=; path=/; max-age=0'
    if (held) held.textContent = 'cleared — reload for a cold visit'
  })
}

async function boot(): Promise<void> {
  state.stage = 'controls'
  wireControls()
  state.stage = 'residency'
  await residencyReadout()
  state.stage = 'adopting'
  const regions = await adoptRegions()
  state.regions = regions.length
  state.stage = 'adopted'

  const onClick = (id: string, run: (w: Wire) => Promise<void> | void): void => {
    document.getElementById(id)?.addEventListener('click', () => {
      void wire(regions).then(run)
    })
  }

  onClick('feed-connect', () => {})
  onClick('feed-tick', async () => {
    // A tick invalidates one key on the server. Every connection holding it gets a STALE frame, and
    // each of them then asks for a delta — the first to ask pays for it and the rest are handed it.
    const response = await fetch('/api/tick', { method: 'POST' })
    if (!response.ok) {
      log('down', `tick refused ${response.status}: ${(await response.text()).slice(0, 120)}`)
      return
    }
    const result = (await response.json()) as { tick: number; notified: number }
    log('down', `tick ${result.tick} invalidated the feed key · ${result.notified} connections told`)
  })

  onClick('cart-add', async (w) => {
    // The guess is staged into an epoch, so it paints nothing. The server stages the truth into the
    // same epoch and commits, and one paint replaces the other.
    await w.send([
      w.client.intent('cart.add', { sku: sku(), qty: 1 }, { epoch: `o-${Date.now()}` }) as ChannelFrame,
    ])
  })
  onClick('cart-fail', async (w) => {
    await w.send([
      w.client.intent(
        'cart.add',
        { sku: sku(), qty: 1, fail: true },
        { epoch: `o-${Date.now()}` },
      ) as ChannelFrame,
    ])
  })
  onClick('cart-refresh', async (w) => {
    await w.send([{ kind: 'REFRESH', header: { s: 'cart' } }])
  })

  state.stage = 'wired'
  if (document.querySelector('[data-channel]')) await wire(regions)
  state.stage = 'ready'
}

void boot().catch((error: unknown) => {
  const box = document.getElementById('frame-log')
  if (box) box.textContent = `boot failed: ${String(error)}`
  throw error
})
