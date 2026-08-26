import { build, createApp, discover, loadBuild, loadConfig, serveApp } from 'weft/server'
import { describeLink, withLink, type LinkOptions } from './link.ts'
import { summarize, type Summary } from '../stats.ts'
import { laneDeliversEvents, launchEngine, type EngineName, type PageLike } from './browser.ts'
import { reachableUrl } from './device.ts'

/**
 * What a link costs, staged against not staged.
 *
 * The comparison is between two paths through the *same* application and the same product code.
 * A staged click is answered by the framework: the document was fetched on hover, so the click is
 * a DOM swap. An unstaged click is handed back to the browser, which is what a link has always
 * cost — and the way it is made unstaged is `data-weft-prefetch="off"` on the document, which is
 * the escape hatch the framework already offers rather than a switch invented for the harness.
 *
 * Both numbers are the page's own clock, and both mean the same thing: from the moment the
 * navigation begins to the moment the target route is interactive. The staged figure is the
 * runtime's `nav.lastMs`, timed from the click to the swapped-in regions being adopted. The
 * browser figure is `readyAt` in the new document, which `performance.now()` measures from that
 * document's navigation start — so it contains the request, the response, the parse and the boot.
 *
 * Timed inside rather than outside because outside does not work: driving a click and polling for
 * a condition over the automation protocol costs tens of milliseconds, the two paths end on
 * different signals, and the overhead was larger than the thing being measured. Neither figure is
 * a first-contentful-paint number and neither should be quoted as one.
 *
 * What it does not measure: bytes. A staged navigation transfers the same document as an
 * unstaged one, on the same route, from the same kernel. The saving is *when*, never *how much*.
 *
 * On loopback the two paths differ by a render and a parse, which is real and small. What the
 * staged path actually removes is a round trip, and loopback has no round trip in it — so
 * `--latency` puts one back through the same TCP proxy the streaming axes use, and `--bandwidth`
 * and `--loss` put a rate and a hole in it. What is still absent is the handshake, ack clocking,
 * and every competing flow; all of those make a real link worse than this one.
 */
export interface NavSample {
  /** Click to the target route being interactive, in milliseconds. */
  ms: number
  /** Documents the browser requested during this sample. A staged click makes none. */
  documents: number
}

export interface NavPair {
  from: string
  to: string
  staged: { samples: NavSample[]; summary: Summary }
  browser: { samples: NavSample[]; summary: Summary }
}

export interface NavReport {
  root: string
  engine: EngineName
  engineVersion: string
  iterations: number
  latencyMs: number
  bandwidthKbps: number
  lossPercent: number
  /** The link these numbers were measured over, in the words the report prints. */
  link: string
  pairs: NavPair[]
  /** Routes whose layout carries no client runtime, so the two paths have no common clock. */
  skipped: string[]
  /** Clicks that beat the staging they were meant to use, and were taken again rather than counted. */
  raced: number
}

export interface NavOptions {
  root: string
  engine: EngineName
  iterations: number
  /** Which page to start from. Defaults to the application's root. */
  from?: string
  /** Which links to click. Defaults to every internal link the starting page carries. */
  to?: string[]
  /** Injected round-trip time, in milliseconds. Zero serves the application directly. */
  latencyMs?: number
  /** Injected link rate, in kilobits per second each way. Zero leaves the link infinitely fast. */
  bandwidthKbps?: number
  /** Injected per-packet loss, as a percentage. */
  lossPercent?: number
}

interface Driver extends PageLike {
  goto(url: string, opts?: unknown): Promise<unknown>
  waitForFunction(expression: string, arg?: unknown, options?: unknown): Promise<unknown>
  waitForTimeout(ms: number): Promise<void>
  hover(selector: string): Promise<void>
  click(selector: string, options?: unknown): Promise<void>
  $$eval<T>(selector: string, fn: (nodes: Element[]) => T): Promise<T>
  on(event: string, handler: (payload: never) => void): void
}

const READY = "window.weft && window.weft.stage === 'running'"

/**
 * Arrived, and finished arriving.
 *
 * The two paths finish differently and a fair comparison has to wait for the same thing on both.
 * A staged commit never reloads, so the document is `complete` throughout and what says the page
 * is done is the runtime's own navigation counter ticking — which it does after the regions of
 * the new page have been adopted. A browser navigation is a new document, so it is `complete`
 * plus that document's runtime having finished booting, which is also where its figure comes from.
 *
 * A route whose layout carries no client runtime cannot be measured this way and is skipped by
 * name rather than compared against a different clock. The demo's race pages are that case, and
 * waiting for a `window.weft` that will never exist is how this measurement first hung.
 */
/**
 * Arrived, and finished arriving — told apart by a marker rather than by a timer.
 *
 * A staged commit and a fallback both end with the same URL in the address bar, and the pathname
 * changes at `pushState`, which is *before* the new regions are adopted. Waiting on "the URL is
 * right and the page looks loaded" therefore stops in the middle of a commit and reads a counter
 * that has not been written yet — which is how a working navigation was reported as one the
 * framework had refused. So a marker is set on the document before the click: it survives a swap
 * and cannot survive a navigation, and the two cases are then separable at all.
 */
const MARKER = 'window.__weftSample'

function arrived(path: string, staged: number | null): string {
  const at_ = `location.pathname === ${JSON.stringify(path)}`
  const loaded = `document.readyState === 'complete' && ${READY}`
  if (staged !== null) return `${at_} && ${READY} && (window.weft.nav.staged === ${staged} || !${MARKER})`
  return `${at_} && ${loaded}`
}

function at(url: string): string {
  return new URL(url).pathname
}

/**
 * One click, timed. `stage` decides which path it takes, and it takes it through the framework's
 * own decision rather than through anything this file does to the page.
 */
async function sample(
  page: Driver,
  origin: string,
  from: string,
  href: string,
  stage: boolean,
  documents: { count: number },
  timeout: number,
): Promise<NavSample | null> {
  await page.goto(new URL(from, origin).href, { waitUntil: 'load' })
  await page.waitForFunction(READY, undefined, { timeout })
  await page.evaluate(
    `document.documentElement.dataset.weftPrefetch = ${JSON.stringify(stage ? 'on' : 'off')}`,
  )

  const selector = `a[href="${href}"]`
  if (stage) {
    await page.hover(selector)
    // Hover intent is 65ms and the document has to arrive; the wait is for the answer to be
    // *held*, so a slow route is measured as staged rather than as a click that raced it.
    await page.waitForFunction(
      `window.weft.staged.some((u) => new URL(u).pathname === ${JSON.stringify(at(new URL(href, origin).href))})`,
      undefined,
      { timeout },
    )
  }

  const before = documents.count
  const ticks = stage ? ((await page.evaluate<number>('window.weft.nav.staged')) as number) + 1 : null
  await page.evaluate(`${MARKER} = true`)
  await page.click(selector)
  await page.waitForFunction(arrived(at(new URL(href, origin).href), ticks), undefined, { timeout })
  // A staged click the framework did not answer is not a staged sample. It happens when the
  // click and the staging race each other, so it is retried rather than averaged in — and
  // counted, because a route that keeps doing it is telling the reader of this report something.
  if (stage && ((await page.evaluate<number>('window.weft.nav.staged')) as number) !== ticks) {
    return null
  }
  const ms = (await page.evaluate<number>(stage ? 'window.weft.nav.lastMs' : 'window.weft.readyAt')) as number
  return { ms, documents: documents.count - before }
}

/** One sample, retried while the click keeps racing the staging it was supposed to use. */
async function sampled(
  page: Driver,
  origin: string,
  from: string,
  href: string,
  stage: boolean,
  documents: { count: number },
  timeout: number,
  raced: { count: number },
): Promise<NavSample> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const taken = await sample(page, origin, from, href, stage, documents, timeout)
    if (taken) return taken
    raced.count++
  }
  throw new Error(
    `E_NOT_STAGED: four clicks on ${href} in a row were handed to the browser, so there is no ` +
      `staged figure for it. The answer was staged and was no longer held when it was clicked.`,
  )
}

export async function measureNavigation(options: NavOptions): Promise<NavReport> {
  // The documents count is not decoration: it is what separates a staged click from one the
  // framework handed back to the browser. A lane that cannot deliver the request event cannot
  // tell those apart, so it refuses rather than reporting a ratio between two unknowns.
  if (!laneDeliversEvents(options.engine)) {
    throw new Error(
      `E_LANE_CANNOT: the ${options.engine} lane cannot deliver browser events, and a staged click is ` +
        `told from an unstaged one by counting documents. Run this axis on a cdp lane or a desktop engine`,
    )
  }

  // The build path rather than dev: `weft dev` serves TypeScript with its types stripped, and a
  // navigation measured against unminified modules is a number about this repository's checkout.
  await build(options.root)
  const config = await loadConfig(options.root, {})
  const discovered = await discover(options.root, config.srcDir)
  const compiled = await loadBuild(discovered, config)
  const app = await createApp(options.root, { mode: 'start', compiled, port: 0 })
  const serving = await serveApp(app)
  const latencyMs = options.latencyMs ?? 0
  const link: LinkOptions = {
    rttMs: latencyMs,
    ...(options.bandwidthKbps ? { kbps: options.bandwidthKbps } : {}),
    ...(options.lossPercent ? { lossPercent: options.lossPercent } : {}),
  }
  const shaped = latencyMs > 0 || Boolean(options.bandwidthKbps) || Boolean(options.lossPercent)
  const proxy = shaped ? await withLink(serving.url, link) : null
  const origin = reachableUrl(options.engine, proxy?.url ?? serving.url)

  const browser = await launchEngine(options.engine)
  const context = await browser.newContext()
  const page = (await context.newPage()) as Driver
  const documents = { count: 0 }
  page.on('pageerror', ((error: { message: string }) => {
    process.stderr.write(`  page error: ${error.message}\n`)
  }) as never)
  page.on('request', ((request: { resourceType(): string }) => {
    if (request.resourceType() === 'document') documents.count++
  }) as never)

  // Every wait scales with the injected link: a page that streams four slow slots pays the round
  // trip several times over, a rate-limited one pays for its bytes as well, and a timeout that
  // does not know about either looks like a hang.
  const timeout = 20_000 + latencyMs * 60 + (options.bandwidthKbps ? 60_000 : 0)

  try {
    const from = options.from ?? '/'
    await page.goto(new URL(from, origin).href, { waitUntil: 'load' })
    await page.waitForFunction(READY, undefined, { timeout })
    const found = await page.$$eval('a[href^="/"]', (nodes) =>
      nodes.map((node) => node.getAttribute('href') ?? ''),
    )
    const targets = (options.to?.length ? options.to : [...new Set(found)]).filter(
      (href) => href && new URL(href, origin).pathname !== new URL(from, origin).pathname,
    )
    if (!targets.length) {
      throw new Error(`E_NO_LINKS: ${from} links nowhere this measurement can click`)
    }

    const pairs: NavPair[] = []
    const skipped: string[] = []
    const raced = { count: 0 }
    for (const href of targets) {
      await page.goto(new URL(href, origin).href, { waitUntil: 'load' })
      if (!(await page.evaluate<boolean>('Boolean(window.weft)'))) {
        skipped.push(href)
        continue
      }
      const staged: NavSample[] = []
      const plain: NavSample[] = []
      // Alternated rather than run in blocks, so a server that warms up or a machine that
      // throttles moves both figures instead of one.
      for (let i = 0; i < options.iterations; i++) {
        staged.push(await sampled(page, origin, from, href, true, documents, timeout, raced))
        plain.push(await sampled(page, origin, from, href, false, documents, timeout, raced))
      }
      pairs.push({
        from,
        to: href,
        staged: { samples: staged, summary: summarize(staged.map((s) => s.ms)) },
        browser: { samples: plain, summary: summarize(plain.map((s) => s.ms)) },
      })
    }

    return {
      root: options.root,
      engine: options.engine,
      engineVersion: browser.version(),
      iterations: options.iterations,
      latencyMs,
      bandwidthKbps: options.bandwidthKbps ?? 0,
      lossPercent: options.lossPercent ?? 0,
      link: describeLink(link),
      pairs,
      skipped,
      raced: raced.count,
    }
  } finally {
    await browser.close()
    await proxy?.close()
    await serving.close()
  }
}

export function formatNavigation(report: NavReport): string {
  const lines: string[] = [
    '',
    `  ${report.root} in ${report.engine} ${report.engineVersion}, ${report.iterations} samples each way`,
    `  ${report.latencyMs > 0 || report.bandwidthKbps > 0 || report.lossPercent > 0 ? report.link : 'loopback: the round trip a staged click removes is not in these numbers'}`,
    "  navigation to interactive, on the page's own clock: nav.lastMs staged, readyAt in a new document",
    '',
    `  ${'route'.padEnd(30)}${'staged'.padStart(10)}${'browser'.padStart(11)}${'ratio'.padStart(9)}   documents`,
  ]
  for (const pair of report.pairs) {
    const ratio = pair.browser.summary.p50 / pair.staged.summary.p50
    const docs = `${pair.staged.samples.reduce((n, s) => n + s.documents, 0)} vs ${pair.browser.samples.reduce((n, s) => n + s.documents, 0)}`
    lines.push(
      `  ${pair.to.padEnd(30)}${`${pair.staged.summary.p50.toFixed(1)}ms`.padStart(10)}` +
        `${`${pair.browser.summary.p50.toFixed(1)}ms`.padStart(11)}${`${ratio.toFixed(2)}×`.padStart(9)}   ${docs}`,
    )
  }
  if (report.raced) {
    lines.push(
      '',
      `  ${report.raced} click${report.raced === 1 ? '' : 's'} beat the staging and were taken again:`,
      '  a click the framework hands to the browser is not a staged sample and is not averaged in',
    )
  }
  if (report.skipped.length) {
    lines.push(
      '',
      `  skipped: ${report.skipped.join(', ')} — no client runtime on those pages, so the two paths`,
      '  have no common clock and a comparison would be between two different definitions',
    )
  }
  lines.push(
    '',
    '  The bytes are the same both ways: a staged click transfers the document on hover instead',
    '  of on the click. What is measured is when it arrives, never how much of it there is.',
    '',
  )
  return lines.join('\n')
}
