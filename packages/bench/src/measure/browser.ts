import { laneFor, openDevice, type CdpConnector } from './device.ts'

/** Every engine name this harness accepts. See `spec/baseline/devices.md`. */
export type EngineName = 'chromium' | 'firefox' | 'webkit' | 'ios' | 'android'

/** The three that Playwright launches locally. */
export const LOCAL_ENGINES: EngineName[] = ['chromium', 'firefox', 'webkit']

/** The two that need hardware, and refuse by name until `--devices` supplies it. */
export const DEVICE_ENGINES: EngineName[] = ['ios', 'android']

/** Engine names this harness accepts and cannot run *on its own*, with what each one is missing. See `spec/baseline/devices.md`. */
export const ENGINES_UNAVAILABLE: Record<string, string> = {
  ios: 'a real iOS device, and a `--devices` entry pointing at it. Playwright cannot drive one — WKWebView on a device needs XCUITest through Appium, which the webdriver lane speaks — and webkit is a desktop proxy, so there is nothing here to fall back to that would be honest',
  'ios-safari': 'the same device. See `ios`',
  android:
    'a real Android device, and a `--devices` entry pointing at it over cdp. chromium stands in for a current Android WebView and not for an AOSP or Play-Store-lagging one, which is the case worth measuring',
}

/** What a desktop engine can and cannot stand in for. See `spec/baseline/devices.md`. */
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
  // A device stands for itself, unlike the three rows above.
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

/** Playwright is optional. No generic measurement here — only the loader and the proxy table. */
export async function loadPlaywright(): Promise<PlaywrightModule | null> {
  try {
    return (await import('playwright')) as unknown as PlaywrightModule
  } catch {
    return null
  }
}

/** Open a browser for an engine name, wherever it lives. A local engine launches; a device engine connects to the named driver. */
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

/** Why a set of engines cannot be run, or null. A webdriver device lane needs no Playwright at all. */
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
