import { readFileSync } from 'node:fs'
import type { BrowserLike, ContextLike, EngineName, PageLike } from './browser.ts'

/** The device lane: how a real phone gets driven by this harness. See `spec/baseline/devices.md`. */
export type DeviceTransport = 'cdp' | 'webdriver'

export interface DeviceDescriptor {
  /** Free-form, and printed with every result: `pixel-6a-aosp`, `iphone-se-ios-16`. */
  id: string
  /** Which `--engines` name this device answers to. */
  engine: EngineName
  transport: DeviceTransport
  /** Where the driver listens. A CDP lane wants the DevTools endpoint; a WebDriver lane wants the server's base URL. */
  endpoint: string
  /** W3C capabilities, merged into `alwaysMatch`. Ignored by the CDP lane. */
  capabilities?: Record<string, unknown>
  /** The Appium context to switch into after the session opens, typically `WEBVIEW_1`. See `spec/baseline/devices.md`. */
  context?: string
  /** The host the *device* uses to reach this machine. Absent means loopback. See `spec/baseline/devices.md`. */
  reachHost?: string
  /** What this device is, in the words the report prints. Required: an unlabelled device is a claim. */
  label: string
}

export interface DeviceLane {
  device: DeviceDescriptor
  /** What this transport can carry. An axis that needs something absent refuses by name. */
  supports: { events: boolean; pointer: boolean; isolatedContexts: boolean }
}

const LANES = new Map<EngineName, DeviceLane>()

/** What each transport can do, so an axis can refuse before it measures rather than after. */
function supportsOf(transport: DeviceTransport): DeviceLane['supports'] {
  return transport === 'cdp'
    ? { events: true, pointer: true, isolatedContexts: true }
    : { events: false, pointer: true, isolatedContexts: false }
}

export function registerDevices(devices: DeviceDescriptor[]): void {
  LANES.clear()
  for (const device of devices) {
    if (!device.id || !device.label) {
      throw new Error(
        `E_DEVICE_UNLABELLED: every device needs an id and a label; got ${JSON.stringify(device)}`,
      )
    }
    if (device.transport !== 'cdp' && device.transport !== 'webdriver') {
      throw new Error(
        `E_DEVICE_TRANSPORT: ${device.id} declares '${device.transport}'; known: cdp, webdriver`,
      )
    }
    if (LANES.has(device.engine)) {
      throw new Error(
        `E_DEVICE_AMBIGUOUS: ${device.engine} is claimed by both ${LANES.get(device.engine)?.device.id} and ${device.id}. ` +
          `One device per engine name: a number aggregated over two devices is not a number about either`,
      )
    }
    LANES.set(device.engine, { device, supports: supportsOf(device.transport) })
  }
}

export function laneFor(engine: EngineName): DeviceLane | undefined {
  return LANES.get(engine)
}

export function lanes(): DeviceLane[] {
  return [...LANES.values()]
}

/** `--devices FILE`, or `WEFT_BENCH_DEVICES` for a CI runner that has a phone on a shelf. */
export function loadDevices(path: string | undefined): DeviceDescriptor[] {
  const file = path ?? process.env.WEFT_BENCH_DEVICES
  if (!file) return []
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as DeviceDescriptor[]
  if (!Array.isArray(parsed)) throw new Error(`E_DEVICE_CONFIG: ${file} is not an array of devices`)
  return parsed
}

/** The URL to hand a device for a server bound to this machine. See `spec/baseline/devices.md`. */
export function reachableUrl(engine: EngineName, url: string): string {
  const lane = LANES.get(engine)
  if (!lane?.device.reachHost) return url
  const rewritten = new URL(url)
  rewritten.hostname = lane.device.reachHost
  return rewritten.href
}

/** The page surface a device lane offers: the subset the browser axes actually use. A lane is judged against this, not Playwright. */
export interface DevicePage extends PageLike {
  waitForFunction(expression: string, arg?: unknown, options?: { timeout?: number }): Promise<unknown>
  waitForTimeout(ms: number): Promise<void>
  click(selector: string): Promise<void>
  hover(selector: string): Promise<void>
  $$eval<T>(selector: string, fn: (nodes: Element[]) => T): Promise<T>
}

/* ------------------------------------------------------------------ W3C WebDriver */

interface Response_<T> {
  value: T
}

/** A driver that is not there is named, not reported as `fetch failed`. See `spec/baseline/devices.md`. */
async function reach(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (error) {
    throw new Error(
      `E_DEVICE_UNREACHABLE: ${url} did not answer (${error instanceof Error ? error.message : String(error)}). ` +
        `Run 'weft-bench devices' to check the driver is up and the tunnel is open`,
      { cause: error },
    )
  }
}

async function call<T>(base: string, method: string, path: string, body?: unknown): Promise<T> {
  const response = await reach(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { 'content-type': 'application/json', accept: 'application/json' },
  })
  const text = await response.text()
  let parsed: Response_<T> | { value?: { error?: string; message?: string } }
  try {
    parsed = JSON.parse(text) as Response_<T>
  } catch {
    throw new Error(`E_WEBDRIVER: ${method} ${path} returned ${response.status}: ${text.slice(0, 200)}`)
  }
  if (!response.ok) {
    const error = (parsed as { value?: { error?: string; message?: string } }).value
    throw new Error(
      `E_WEBDRIVER: ${method} ${path} — ${error?.error ?? response.status}: ${error?.message ?? text.slice(0, 200)}`,
    )
  }
  return (parsed as Response_<T>).value
}

/** A string is an expression; a function is called with no arguments. Both become a script body. */
function scriptOf(fn: string | ((...args: never[]) => unknown)): string {
  return typeof fn === 'string' ? `return (${fn})` : `return (${fn.toString()}).call(null)`
}

class WebDriverPage implements DevicePage {
  private readonly base: string
  private readonly session: string

  constructor(base: string, session: string) {
    this.base = base
    this.session = session
  }

  private at(path: string): string {
    return `/session/${this.session}${path}`
  }

  async goto(url: string): Promise<unknown> {
    return call<unknown>(this.base, 'POST', this.at('/url'), { url })
  }

  async evaluate<T>(fn: string | ((...args: never[]) => T)): Promise<T> {
    return call<T>(this.base, 'POST', this.at('/execute/sync'), { script: scriptOf(fn), args: [] })
  }

  /** Polled here, not via `execute/async`: a page that just navigated has no callback to call. 50ms matches the protocol's own round-trip floor. */
  async waitForFunction(
    expression: string,
    _arg?: unknown,
    options?: { timeout?: number },
  ): Promise<unknown> {
    const deadline = performance.now() + (options?.timeout ?? 30_000)
    for (;;) {
      const value = await this.evaluate<unknown>(`Boolean(${expression})`)
      if (value) return value
      if (performance.now() > deadline) {
        throw new Error(`E_WEBDRIVER_TIMEOUT: ${expression} never became true`)
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  async waitForTimeout(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms))
  }

  private async element(selector: string): Promise<string> {
    const found = await call<Record<string, string>>(this.base, 'POST', this.at('/element'), {
      using: 'css selector',
      value: selector,
    })
    const id = Object.values(found)[0]
    if (!id) {
      throw new Error(
        `E_WEBDRIVER_NO_ELEMENT: nothing on the page matches '${selector}'. On a device lane this is ` +
          `usually the wrong webview context rather than a missing element`,
      )
    }
    return id
  }

  async click(selector: string): Promise<void> {
    await call<null>(this.base, 'POST', this.at(`/element/${await this.element(selector)}/click`), {})
  }

  async hover(selector: string): Promise<void> {
    const id = await this.element(selector)
    await call<null>(this.base, 'POST', this.at('/actions'), {
      actions: [
        {
          type: 'pointer',
          id: 'mouse',
          parameters: { pointerType: 'mouse' },
          actions: [
            { type: 'pointerMove', duration: 0, origin: { 'element-6066-11e4-a52e-4f735466cecf': id } },
          ],
        },
      ],
    })
  }

  async $$eval<T>(selector: string, fn: (nodes: Element[]) => T): Promise<T> {
    return call<T>(this.base, 'POST', this.at('/execute/sync'), {
      script: `return (${fn.toString()})(Array.prototype.slice.call(document.querySelectorAll(arguments[0])))`,
      args: [selector],
    })
  }

  /** W3C WebDriver has no event stream. See `spec/baseline/devices.md`: `E_LANE_CANNOT`. */
  on(event: string): void {
    throw new Error(
      `E_LANE_CANNOT: the webdriver lane cannot deliver '${event}' — W3C WebDriver has no event stream. ` +
        `Run this axis on a cdp lane, or on a desktop engine`,
    )
  }

  /** Nothing to close: a W3C session is the page, and the context closes the session. */
  async close(): Promise<void> {}
}

class WebDriverContext implements ContextLike {
  private readonly base: string
  private readonly session: string

  constructor(base: string, session: string) {
    this.base = base
    this.session = session
  }

  async newPage(): Promise<PageLike> {
    return new WebDriverPage(this.base, this.session)
  }

  async close(): Promise<void> {
    await call<null>(this.base, 'DELETE', `/session/${this.session}`).catch(() => null)
  }
}

/** One W3C session per context — a session is the only isolation the protocol offers. See `spec/baseline/devices.md`. */
class WebDriverBrowser implements BrowserLike {
  private label = 'webdriver'
  private readonly device: DeviceDescriptor

  constructor(device: DeviceDescriptor) {
    this.device = device
  }

  version(): string {
    return `${this.device.id} (${this.label})`
  }

  async newContext(): Promise<ContextLike> {
    const base = this.device.endpoint.replace(/\/$/, '')
    const created = await call<{ sessionId?: string; capabilities?: Record<string, unknown> }>(
      base,
      'POST',
      '/session',
      { capabilities: { alwaysMatch: this.device.capabilities ?? {}, firstMatch: [{}] } },
    )
    const session = created.sessionId
    if (!session) throw new Error(`E_WEBDRIVER: ${this.device.id} opened no session`)
    const browserName = created.capabilities?.browserName
    const browserVersion = created.capabilities?.browserVersion ?? created.capabilities?.platformVersion
    this.label = [browserName, browserVersion].filter(Boolean).join(' ') || 'webdriver'

    if (this.device.context) {
      await call<null>(base, 'POST', `/session/${session}/context`, { name: this.device.context })
    }
    return new WebDriverContext(base, session)
  }

  async close(): Promise<void> {}
}

/* ------------------------------------------------------------------ opening a lane */

export interface CdpConnector {
  connectOverCDP(endpoint: string): Promise<BrowserLike>
}

/** Open the device this engine name points at. Playwright's connector is passed in to keep this module free of the optional dependency. */
export async function openDevice(lane: DeviceLane, cdp: CdpConnector | null): Promise<BrowserLike> {
  if (lane.device.transport === 'webdriver') return new WebDriverBrowser(lane.device)
  if (!cdp) {
    throw new Error(
      `E_NO_PLAYWRIGHT: the cdp lane for ${lane.device.id} drives the device through Playwright's connectOverCDP`,
    )
  }
  try {
    return await cdp.connectOverCDP(lane.device.endpoint)
  } catch (error) {
    throw new Error(
      `E_DEVICE_UNREACHABLE: ${lane.device.id} at ${lane.device.endpoint} did not answer ` +
        `(${error instanceof Error ? error.message : String(error)}). For an Android WebView this is ` +
        `usually a missing 'adb forward tcp:PORT localabstract:webview_devtools_remote_<pid>'`,
      { cause: error },
    )
  }
}

/** Is the driver on the other end of this descriptor answering? The `devices` command's whole job. */
export async function probeDevice(device: DeviceDescriptor): Promise<{ ok: boolean; detail: string }> {
  const base = device.endpoint.replace(/\/$/, '')
  const path = device.transport === 'cdp' ? '/json/version' : '/status'
  try {
    const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(3_000) })
    if (!response.ok) return { ok: false, detail: `${base}${path} responded ${response.status}` }
    const body = (await response.json()) as Record<string, unknown>
    const said =
      device.transport === 'cdp'
        ? String(body.Browser ?? body['User-Agent'] ?? 'a devtools endpoint')
        : JSON.stringify((body as { value?: unknown }).value ?? body).slice(0, 120)
    return { ok: true, detail: said }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}
