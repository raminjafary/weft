/**
 * The demo's own client code, and all that is left of it.
 *
 * `app/client.ts` is loaded by the framework's boot after it has adopted the page, wired the
 * intents and — on a page with a live region — opened the channel. So everything this file used to
 * do is gone: no adoption, no resident store, no signal creation, no frame decoder, no channel, no
 * intent dispatch. Four hundred lines became this.
 *
 * What is genuinely the demo's own is here: a station's controls are query parameters, so the
 * sliders need a button that puts them in the URL, and the range inputs deserve a live readout.
 * Neither of those is a framework concern, and neither would exist in an ordinary application.
 */
/**
 * The state the framework's client publishes.
 *
 * Read through a cast rather than by augmenting `Window` again: the framework already declares it,
 * and a second declaration of the same property is an error even when the two agree.
 */
interface WeftState {
  writes: number
  connected: boolean
  stage: string
  regions: number
}

const published = (): WeftState | undefined => (window as unknown as { weft?: WeftState }).weft

/**
 * Which query parameter each control writes.
 *
 * It is a table because the ids are the station's, not the framework's: a station page invents a
 * slider called `feed-rows` and decides it means `rows`. A framework that guessed this mapping
 * would be guessing.
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
  'dash-budget': 'budget',
  'dash-exceed': 'exceed',
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

/** The race frames reload in place, so the arrival order can be watched without losing the sliders. */
function rerunRace(): void {
  for (const frame of document.querySelectorAll('.race-frames iframe')) {
    const element = frame as HTMLIFrameElement
    const url = new URL(element.src, window.location.href)
    for (const control of ['race-slow', 'race-fast', 'race-medium']) {
      const input = document.getElementById(control) as HTMLInputElement | null
      if (input) url.searchParams.set(CONTROL_KEYS[control] as string, input.value)
    }
    url.searchParams.set('t', String(Date.now()))
    element.src = url.toString()
  }
}

function wireControls(): void {
  for (const node of document.querySelectorAll('button[id]')) {
    const id = node.id
    if (id === 'race-run') {
      node.addEventListener('click', rerunRace)
      continue
    }
    // A button that names an intent is the framework's to wire. Reloading the page underneath it
    // would throw away the delta the intent is about to produce.
    if ((node as HTMLElement).dataset.weftIntent) continue
    // Every "go" button on a station page does the same thing, because every control on a
    // server-rendered page is a query parameter.
    if (/-(go|run|reschedule|reload)$/.test(id)) node.addEventListener('click', reloadWithControls)
  }
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

/** The residency station's two readouts. IndexedDB is the client's, so only the client can say. */
async function residency(): Promise<void> {
  const held = document.getElementById('residency-held')
  const forget = document.getElementById('residency-forget')
  if (!held && !forget) return
  const databases = await indexedDB.databases()
  if (held) held.textContent = `${databases.length} database(s) · ${databases.map((d) => d.name).join(', ')}`
  forget?.addEventListener('click', () => {
    indexedDB.deleteDatabase('weft')
    document.cookie = 'weft-resident=; path=/; max-age=0'
    if (held) held.textContent = 'cleared — reload for a cold visit'
  })
}

/** The channel readout every live showcase carries, filled from the state the framework publishes. */
function channelReadout(): void {
  const mark = document.getElementById('channel-state')
  const writes = document.getElementById('channel-writes')
  if (!mark && !writes) return
  const paint = (): void => {
    const state = published()
    if (mark)
      mark.textContent = state?.connected ? `open · ${state.regions} region(s)` : (state?.stage ?? 'idle')
    if (writes) writes.textContent = `${state?.writes ?? 0} DOM writes`
  }
  paint()
  window.setInterval(paint, 500)
}

wireControls()
channelReadout()
void residency()
