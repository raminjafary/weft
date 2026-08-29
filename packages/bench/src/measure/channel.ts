import { build, createApp, discover, loadBuild, loadConfig, serveApp } from '@weftjs/core/server'
import { laneDeliversEvents, launchEngine, type EngineName } from './browser.ts'
import { reachableUrl } from './device.ts'

/** Which binding a real browser actually opens, and what happens when it cannot open the one it wants. See `spec/kernel/transport.md`. */
export interface ChannelCheck {
  name: string
  ok: boolean
  detail?: string
}

export interface ChannelRun {
  engine: EngineName
  engineVersion: string
  checks: ChannelCheck[]
}

interface Driver {
  goto(url: string, options?: { waitUntil?: string }): Promise<unknown>
  waitForFunction(expression: string, arg?: unknown, options?: { timeout?: number }): Promise<unknown>
  routeWebSocket?(pattern: string, handler: (ws: { close(): void }) => void): Promise<void>
  evaluate<T>(expression: string): Promise<T>
  close(): Promise<void>
  on(event: string, handler: (value: never) => void): void
}

/** A live page: the demo's cart is the one with a channel and a refreshable region. */
const LIVE = '/app/cart'
const CONNECTED = 'Boolean(window.weft && window.weft.connected)'

export async function measureChannel(root: string, engine: EngineName): Promise<ChannelRun> {
  if (!laneDeliversEvents(engine)) {
    throw new Error(
      `E_LANE_CANNOT: the ${engine} lane cannot deliver page errors, and this measurement reports them as checks`,
    )
  }

  // The build path, not dev — same reason as the navigation measurement.
  await build(root)
  const config = await loadConfig(root, {})
  const discovered = await discover(root, config.srcDir)
  const compiled = await loadBuild(discovered, config)
  const app = await createApp(root, { mode: 'start', compiled, port: 0 })
  const serving = await serveApp(app)

  const checks: ChannelCheck[] = []
  const browser = await launchEngine(engine)
  try {
    const context = await browser.newContext()

    /** What the *server* says this channel is, which is the only account of it that cannot lie. */
    const bindings = (): string[] => {
      const out: string[] = []
      for (const id of app.at.keys()) {
        const channel = app.hub.get(id)
        if (channel) out.push(channel.binding)
      }
      return out
    }

    const page = (await context.newPage()) as Driver
    const errors: string[] = []
    page.on('pageerror', ((error: { message: string }) => errors.push(error.message)) as never)
    await page.goto(new URL(LIVE, reachableUrl(engine, serving.url)).href, { waitUntil: 'load' })
    await page.waitForFunction(CONNECTED, undefined, { timeout: 20_000 })

    const opened = bindings()
    checks.push({
      name: 'a live page opens a socket, and the server says so',
      ok: opened.includes('socket'),
      detail: opened.length ? opened.join(', ') : 'no channel opened at all',
    })

    const negotiated = await page.evaluate<string>(
      "(document.querySelector('[data-weft-log]') ? 'logged' : 'unlogged')",
    )
    checks.push({
      name: 'and the page has no errors from opening it',
      ok: errors.length === 0,
      detail: errors.join('; ') || negotiated,
    })
    await page.close()

    // The same page with the upgrade broken, which is the case the fallback exists for. See `spec/kernel/transport.md`.
    const blocked = (await context.newPage()) as Driver
    const failures: string[] = []
    blocked.on('pageerror', ((error: { message: string }) => failures.push(error.message)) as never)
    if (blocked.routeWebSocket) {
      await blocked.routeWebSocket('**/*', (ws) => ws.close())
      await blocked.goto(new URL(LIVE, reachableUrl(engine, serving.url)).href, { waitUntil: 'load' })
      await blocked.waitForFunction(CONNECTED, undefined, { timeout: 20_000 })
      const fell = bindings()
      checks.push({
        name: 'an upgrade that does not survive the path falls back to the streamed binding',
        ok: fell.includes('stream'),
        detail: fell.join(', ') || 'no channel opened at all',
      })
      checks.push({
        name: 'and a refused upgrade is not an error on the page',
        ok: failures.length === 0,
        detail: failures.join('; ') || 'quiet',
      })
    } else {
      checks.push({
        name: 'an upgrade that does not survive the path falls back to the streamed binding',
        ok: false,
        detail: 'not measured: this playwright has no routeWebSocket, so the failure cannot be caused',
      })
    }
    await blocked.close()
    await context.close()

    return { engine, engineVersion: browser.version(), checks }
  } finally {
    await browser.close()
    await serving.close()
  }
}
