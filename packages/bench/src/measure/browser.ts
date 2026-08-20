export type EngineName = 'chromium' | 'firefox' | 'webkit'

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
