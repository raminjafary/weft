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

export interface BrowserSample {
  fcp: number | null
  lcp: number | null
  domInteractive: number | null
  /** From the candidate's own `candidate:interactive` performance mark. Null means it never fired. */
  interactive: number | null
  transferred: number | null
}

export interface BrowserRun {
  engine: EngineName
  engineVersion: string
  proxyFor: string
  mode: 'cold' | 'repeat'
  samples: BrowserSample[]
}

export interface BrowserOptions {
  engine: EngineName
  iterations: number
  mode: 'cold' | 'repeat'
}

type PlaywrightModule = {
  chromium: { launch(opts?: unknown): Promise<BrowserLike> }
  firefox: { launch(opts?: unknown): Promise<BrowserLike> }
  webkit: { launch(opts?: unknown): Promise<BrowserLike> }
}

interface BrowserLike {
  version(): string
  newContext(): Promise<ContextLike>
  close(): Promise<void>
}

interface ContextLike {
  newPage(): Promise<PageLike>
  close(): Promise<void>
}

interface PageLike {
  goto(url: string, opts?: unknown): Promise<unknown>
  evaluate<T>(fn: string | ((...args: never[]) => T)): Promise<T>
  close(): Promise<void>
}

export async function loadPlaywright(): Promise<PlaywrightModule | null> {
  try {
    return (await import('playwright')) as unknown as PlaywrightModule
  } catch {
    return null
  }
}

const COLLECT = () => {
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
  const paint = performance.getEntriesByName('first-contentful-paint')[0]
  let lcp: number | null = null
  try {
    const entries = performance.getEntriesByType('largest-contentful-paint')
    const last = entries[entries.length - 1]
    lcp = last ? last.startTime : null
  } catch {
    lcp = null
  }
  const mark = performance.getEntriesByName('candidate:interactive')[0]
  return {
    fcp: paint ? paint.startTime : null,
    lcp,
    domInteractive: nav ? nav.domInteractive : null,
    interactive: mark ? mark.startTime : null,
    transferred: nav ? nav.transferSize : null,
  }
}

export async function measureBrowser(url: string, options: BrowserOptions): Promise<BrowserRun> {
  const pw = await loadPlaywright()
  if (!pw) throw new Error('E_NO_PLAYWRIGHT: install playwright to run browser axes')

  const browser = await pw[options.engine].launch()
  const samples: BrowserSample[] = []
  try {
    for (let i = 0; i < options.iterations; i++) {
      const context = await browser.newContext()
      const page = await context.newPage()
      try {
        await page.goto(url, { waitUntil: 'load' })
        if (options.mode === 'repeat') {
          await page.goto(url, { waitUntil: 'load' })
        }
        samples.push(await page.evaluate(COLLECT))
      } finally {
        await page.close()
        await context.close()
      }
    }
    return {
      engine: options.engine,
      engineVersion: browser.version(),
      proxyFor: ENGINE_PROXIES[options.engine].standsFor,
      mode: options.mode,
      samples,
    }
  } finally {
    await browser.close()
  }
}
