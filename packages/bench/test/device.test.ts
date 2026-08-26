import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, type Server } from 'node:http'
import {
  laneFor,
  lanes,
  openDevice,
  probeDevice,
  reachableUrl,
  registerDevices,
  type DeviceDescriptor,
  type DevicePage,
} from '../src/measure/device.ts'
import { ENGINES_UNAVAILABLE, laneDeliversEvents, LOCAL_ENGINES } from '../src/measure/browser.ts'

interface Seen {
  method: string
  path: string
  body: unknown
}

/**
 * A W3C WebDriver server with no device behind it.
 *
 * The measurement needs hardware. The protocol does not — so the client that speaks it can be
 * held to the spec here, which is the difference between a lane that is written and one that is
 * known to send the right requests.
 */
async function fakeDriver(): Promise<{
  base: string
  seen: Seen[]
  values: Map<string, unknown>
  close(): Promise<void>
}> {
  const seen: Seen[] = []
  const values = new Map<string, unknown>()
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body: unknown = raw ? JSON.parse(raw) : undefined
      const path = req.url ?? '/'
      seen.push({ method: req.method ?? 'GET', path, body })

      const reply = (value: unknown, status = 200): void => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ value }))
      }

      if (path === '/status') return reply({ ready: true, message: 'fake driver' })
      if (path === '/session' && req.method === 'POST') {
        return reply({
          sessionId: 's1',
          capabilities: { browserName: 'Safari', browserVersion: '17.4' },
        })
      }
      if (path.endsWith('/execute/sync')) {
        const script = (body as { script: string }).script
        for (const [needle, value] of values) if (script.includes(needle)) return reply(value)
        return reply(null)
      }
      if (path.endsWith('/element') && req.method === 'POST') {
        return reply({ 'element-6066-11e4-a52e-4f735466cecf': 'e1' })
      }
      return reply(null)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address === 'string' || address === null) throw new Error('no address')
  return {
    base: `http://127.0.0.1:${address.port}`,
    seen,
    values,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

function iosDevice(base: string, extra: Partial<DeviceDescriptor> = {}): DeviceDescriptor {
  return {
    id: 'fake-iphone',
    label: 'a fake driver, no device behind it',
    engine: 'ios',
    transport: 'webdriver',
    endpoint: base,
    context: 'WEBVIEW_1',
    capabilities: { platformName: 'iOS' },
    ...extra,
  }
}

test('a device engine is refused by name until config supplies one, and named once it does', () => {
  registerDevices([])
  assert.equal(laneFor('ios'), undefined)
  assert.match(ENGINES_UNAVAILABLE.ios ?? '', /a real iOS device/)
  assert.ok(!LOCAL_ENGINES.includes('ios'))

  registerDevices([iosDevice('http://127.0.0.1:1')])
  assert.equal(laneFor('ios')?.device.id, 'fake-iphone')
  assert.equal(lanes().length, 1)
  registerDevices([])
})

test('one device per engine name: two claiming the same name is refused', () => {
  assert.throws(
    () =>
      registerDevices([iosDevice('http://127.0.0.1:1'), iosDevice('http://127.0.0.1:2', { id: 'other' })]),
    /E_DEVICE_AMBIGUOUS/,
  )
  registerDevices([])
})

test('a device without a label or with an unknown transport is refused', () => {
  assert.throws(() => registerDevices([iosDevice('http://x', { label: '' })]), /E_DEVICE_UNLABELLED/)
  assert.throws(
    () => registerDevices([iosDevice('http://x', { transport: 'bidi' as never })]),
    /E_DEVICE_TRANSPORT/,
  )
  registerDevices([])
})

test('the webdriver lane opens a session, switches context, and speaks W3C', async () => {
  const driver = await fakeDriver()
  registerDevices([iosDevice(driver.base)])
  try {
    driver.values.set('window.weft', true)
    driver.values.set('querySelectorAll', ['/a', '/b'])

    const probe = await probeDevice(iosDevice(driver.base))
    assert.equal(probe.ok, true)

    const browser = await openDevice(laneFor('ios')!, null)
    const context = await browser.newContext()
    assert.match(browser.version(), /fake-iphone \(Safari 17\.4\)/)

    const page = (await context.newPage()) as DevicePage

    await page.goto('http://127.0.0.1:9/app/cart')
    assert.equal(await page.evaluate<boolean>('Boolean(window.weft)'), true)
    await page.waitForFunction('window.weft', undefined, { timeout: 1_000 })
    const hrefs = await page.$$eval('a[href^="/"]', (nodes) => nodes.map((n) => n.getAttribute('href')))
    assert.deepEqual(hrefs, ['/a', '/b'])
    await page.click('a[href="/a"]')
    await page.hover('a[href="/a"]')
    await context.close()
    await browser.close()

    const paths = driver.seen.map((s) => `${s.method} ${s.path}`)
    assert.ok(paths.includes('POST /session'), paths.join('\n'))
    assert.ok(paths.includes('POST /session/s1/context'), 'the webview context is switched into')
    assert.ok(paths.includes('POST /session/s1/url'))
    assert.ok(paths.includes('POST /session/s1/element/e1/click'))
    assert.ok(paths.includes('POST /session/s1/actions'), 'hover is a pointer action')
    assert.ok(paths.includes('DELETE /session/s1'), 'the session is the context, and is closed with it')

    const navigated = driver.seen.find((s) => s.path === '/session/s1/url')
    assert.deepEqual(navigated?.body, { url: 'http://127.0.0.1:9/app/cart' })

    const script = driver.seen.find((s) => s.path.endsWith('/execute/sync'))?.body as { script: string }
    assert.match(script.script, /^return \(/, 'an expression becomes a script body')
  } finally {
    registerDevices([])
    await driver.close()
  }
})

test('the webdriver lane refuses an event subscription instead of dropping it', async () => {
  const driver = await fakeDriver()
  registerDevices([iosDevice(driver.base)])
  try {
    const browser = await openDevice(laneFor('ios')!, null)
    const context = await browser.newContext()
    const page = await context.newPage()
    assert.equal(laneDeliversEvents('ios'), false)
    assert.throws(() => page.on!('request', () => {}), /E_LANE_CANNOT/)
    await context.close()
  } finally {
    registerDevices([])
    await driver.close()
  }
})

test('a waitForFunction that never comes true fails by name rather than hanging', async () => {
  const driver = await fakeDriver()
  registerDevices([iosDevice(driver.base)])
  try {
    const browser = await openDevice(laneFor('ios')!, null)
    const context = await browser.newContext()
    const page = (await context.newPage()) as DevicePage
    await assert.rejects(
      page.waitForFunction('window.nothing', undefined, { timeout: 150 }),
      /E_WEBDRIVER_TIMEOUT/,
    )
    await context.close()
  } finally {
    registerDevices([])
    await driver.close()
  }
})

test('a device is told where this machine is, and a desktop engine is not', () => {
  registerDevices([iosDevice('http://127.0.0.1:1', { reachHost: '10.0.2.2' })])
  assert.equal(reachableUrl('ios', 'http://127.0.0.1:8080/app'), 'http://10.0.2.2:8080/app')
  assert.equal(reachableUrl('webkit', 'http://127.0.0.1:8080/app'), 'http://127.0.0.1:8080/app')
  registerDevices([iosDevice('http://127.0.0.1:1')])
  assert.equal(reachableUrl('ios', 'http://127.0.0.1:8080/app'), 'http://127.0.0.1:8080/app')
  registerDevices([])
})

test('a driver that is not there is reported as down, not as a broken harness', async () => {
  const probe = await probeDevice(iosDevice('http://127.0.0.1:1'))
  assert.equal(probe.ok, false)
  assert.ok(probe.detail.length > 0)
})

test('a lane pointed at nothing refuses by name rather than failing to fetch', async () => {
  registerDevices([iosDevice('http://127.0.0.1:1')])
  try {
    const browser = await openDevice(laneFor('ios')!, null)
    await assert.rejects(browser.newContext(), /E_DEVICE_UNREACHABLE/)
  } finally {
    registerDevices([])
  }
})
