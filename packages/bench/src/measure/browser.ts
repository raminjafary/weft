export type EngineName = 'chromium' | 'firefox' | 'webkit'

/**
 * Engine names this harness accepts and cannot run, with what each one is missing.
 *
 * Declared rather than absent, for the reason every unbound port in this framework is: a capability
 * that does not exist should refuse by name. `--engines ios` used to be an unknown value that failed
 * somewhere inside Playwright with a message about a browser type; it now fails here, saying that
 * what is missing is a device and naming what would have to drive it. That is the difference between
 * a gap somebody can read and one they have to infer from a spec paragraph.
 *
 * A number from any of these is the one claim `spec/baseline/devices.md` says this repository may not
 * make, and the check below is what makes that a gate rather than a habit.
 */
export const ENGINES_UNAVAILABLE: Record<string, string> = {
  ios: 'a real iOS device. Playwright cannot drive one — WKWebView on a device needs XCUITest through Appium, or the Web Inspector protocol over usbmuxd — and webkit is a desktop proxy, so there is nothing here to fall back to that would be honest',
  'ios-safari': 'the same device. See `ios`',
  android:
    'a real Android device. chromium stands in for a current Android WebView and not for an AOSP or Play-Store-lagging one, which is the case worth measuring',
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

export type PlaywrightModule = Record<EngineName, { launch(opts?: unknown): Promise<BrowserLike> }>

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
