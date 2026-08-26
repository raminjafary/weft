import { laneFor, openDevice, type CdpConnector } from './device.ts'

/**
 * Every engine name this harness accepts. The first three are Playwright's. The last two are
 * device lanes: they name themselves rather than a proxy, and they only exist when `--devices`
 * points at hardware.
 */
export type EngineName = 'chromium' | 'firefox' | 'webkit' | 'ios' | 'android'

/** The three that Playwright launches locally. */
export const LOCAL_ENGINES: EngineName[] = ['chromium', 'firefox', 'webkit']

/** The two that need hardware, and refuse by name until `--devices` supplies it. */
export const DEVICE_ENGINES: EngineName[] = ['ios', 'android']

/**
 * Engine names this harness accepts and cannot run *on its own*, with what each one is missing.
 *
 * Declared rather than absent, for the reason every unbound port in this framework is: a capability
 * that does not exist should refuse by name. `--engines ios` used to be an unknown value that failed
 * somewhere inside Playwright with a message about a browser type; it fails here instead, saying
 * that what is missing is a device and naming what would have to drive it.
 *
 * What has changed is that the sentence now ends somewhere. There is a lane — see `./device.ts` —
 * so the missing thing is hardware and a line of config, and the refusal says which. A number from
 * one of these engines without a device behind it is the one claim `spec/baseline/devices.md` says
 * this repository may not make, and the check in `enginesFrom` is what makes that a gate.
 */
export const ENGINES_UNAVAILABLE: Record<string, string> = {
  ios: 'a real iOS device, and a `--devices` entry pointing at it. Playwright cannot drive one — WKWebView on a device needs XCUITest through Appium, which the webdriver lane speaks — and webkit is a desktop proxy, so there is nothing here to fall back to that would be honest',
  'ios-safari': 'the same device. See `ios`',
  android:
    'a real Android device, and a `--devices` entry pointing at it over cdp. chromium stands in for a current Android WebView and not for an AOSP or Play-Store-lagging one, which is the case worth measuring',
}

/**
 * What a desktop engine can and cannot stand in for. Playwright's webkit is the
 * closest available proxy for an iOS webview, and it is not WKWebView on a device:
 * report it as a proxy, never as an iOS number.
 */
export const ENGINE_PROXIES: Record<EngineName, { standsFor: string; notA: string }> = {
  chromium: {
    standsFor: 'desktop Chrome and Edge, Electron, and current Android WebView',
    notA: 'an old or AOSP Android WebView, which lags because it updates through the Play Store',
  },
  firefox: { standsFor: 'desktop Gecko', notA: 'a mobile Gecko build' },
  webkit: {
    standsFor: 'Safari, every iOS webview by policy, and WebKitGTK under Tauri on Linux',
    notA: 'WKWebView on a real device: no app-bound-domain rules, no host-app request interception, and no OS-level suspension',
  },
  // A device stands for itself. That is the entire point of the lane, and the reason these two
  // rows read differently from the three above them.
  ios: {
    standsFor: 'the iOS device the webdriver lane is pointed at, and nothing else',
    notA: 'any other iOS version, and not a claim about iOS: it is a claim about one device, named in the report',
  },
  android: {
    standsFor: 'the Android device the cdp lane is pointed at, and nothing else',
    notA: 'the Android WebView population: a Play-Store-current device says nothing about an AOSP one',
  },
}

export interface PageLike {
  goto(url: string, opts?: unknown): Promise<unknown>
  evaluate<T>(fn: string | ((...args: never[]) => T)): Promise<T>
  close(): Promise<void>
  on?(event: string, handler: (payload: never) => void): void
}

export interface ContextLike {
  newPage(): Promise<PageLike>
  close(): Promise<void>
}

export interface BrowserLike {
  version(): string
  newContext(): Promise<ContextLike>
  close(): Promise<void>
}

export type PlaywrightModule = Record<
  'chromium' | 'firefox' | 'webkit',
  { launch(opts?: unknown): Promise<BrowserLike> }
> &
  Partial<Record<'chromium', CdpConnector>>

/**
 * Playwright is optional. Every browser axis serves its own page and measures inside it,
 * so there is no generic measurement here — only the loader and the proxy table.
 */
export async function loadPlaywright(): Promise<PlaywrightModule | null> {
  try {
    return (await import('playwright')) as unknown as PlaywrightModule
  } catch {
    return null
  }
}

/**
 * Open a browser for an engine name, wherever it lives.
 *
 * Every browser axis used to write `pw[engine].launch()`, which is why the device lane could not
 * exist: the engine name and the way to launch it were the same expression. They are separated
 * here. A local engine launches; a device engine connects to the driver `--devices` named. The
 * caller sees a `BrowserLike` either way and does not branch.
 */
export async function launchEngine(engine: EngineName, opts?: unknown): Promise<BrowserLike> {
  const lane = laneFor(engine)
  const pw = await loadPlaywright()
  if (lane) return openDevice(lane, pw?.chromium ?? null)
  if (!pw) throw new Error('E_NO_PLAYWRIGHT: install playwright to run a browser axis')
  const local = pw[engine as 'chromium' | 'firefox' | 'webkit']
  if (!local) {
    throw new Error(
      `E_NO_DEVICE_ENGINE: '${engine}' needs ${ENGINES_UNAVAILABLE[engine] ?? 'a device this harness cannot reach'}`,
    )
  }
  return local.launch(opts)
}

/**
 * Why a set of engines cannot be run, or null.
 *
 * Playwright is optional, and a webdriver device lane does not need it at all — so "playwright is
 * not installed" is the wrong answer for a run whose only engine is a phone on a cable.
 */
export async function enginesUnrunnable(engines: EngineName[]): Promise<string | null> {
  const needsPlaywright = engines.some((engine) => {
    const lane = laneFor(engine)
    return !lane || lane.device.transport === 'cdp'
  })
  if (needsPlaywright && !(await loadPlaywright())) {
    return 'playwright is not installed: browser axes were not run'
  }
  return null
}

/** Whether this engine's lane can deliver browser events. A desktop engine always can. */
export function laneDeliversEvents(engine: EngineName): boolean {
  return laneFor(engine)?.supports.events ?? true
}
