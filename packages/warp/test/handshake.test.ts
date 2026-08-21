import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  negotiate,
  readResident,
  residentFrame,
  warpFrame,
  WARP_VERSION,
  type ClientHello,
} from '../src/index.ts'

const modern: ClientHello = {
  // A client on the server's own minor. An older minor is a downgrade, and there is a test
  // for that below rather than it being folded silently into every other case.
  warp: WARP_VERSION,
  ir: '1.0.0',
  forms: ['html', 'bundle', 'split', 'patch', 'delta'],
  transport: 'stream',
  dsd: true,
  vt: true,
  sw: true,
  idb: true,
}

test('a modern client gets every form and the streaming strategy', () => {
  const n = negotiate(modern)
  assert.equal(n.ok, true)
  assert.equal(n.strategy, 'stream')
  assert.equal(n.fill, 'dsd')
  assert.equal(n.commit, 'view-transition')
  assert.equal(n.residency, 'service-worker')
  assert.deepEqual(n.downgrades, [])
})

test('an older Warp minor is met at the older minor, and it is reported', () => {
  const n = negotiate({ ...modern, warp: '1.0.0' })
  assert.equal(n.ok, true)
  assert.equal(n.warp, '1.0.0')
  assert.deepEqual(n.downgrades, [`warp ${WARP_VERSION} -> 1.0.0`])
})

test('an IR major mismatch costs every form except html, which needs nothing resident', () => {
  const n = negotiate({ ...modern, ir: '2.0.0' })
  assert.equal(n.ok, true)
  assert.deepEqual(n.forms, ['html'])
})

test('a Warp major mismatch is fatal to the channel, not to the page', () => {
  const n = negotiate({ ...modern, warp: '2.0.0' })
  assert.equal(n.ok, false)
  assert.match(n.fatal ?? '', /E_WARP_MAJOR/)
  assert.deepEqual(n.forms, ['html'])
  assert.equal(n.strategy, 'collapse')
})

test('an intercepted webview request collapses the holes and rules out resume', () => {
  const n = negotiate({ ...modern, transport: 'buffered' })
  assert.equal(n.strategy, 'collapse')
  assert.equal(n.resumable, false)
  assert.equal(n.forms.includes('split'), false)
  assert.equal(
    n.downgrades.some((d) => d.includes('buffered by the host app')),
    true,
  )
})

test('a WKWebView-shaped client loses polish and keeps correctness', () => {
  const n = negotiate({ ...modern, dsd: false, vt: false, sw: false, idb: true })
  assert.equal(n.ok, true)
  assert.equal(n.fill, 'script')
  assert.equal(n.commit, 'instant')
  assert.equal(n.residency, 'indexeddb')
  assert.equal(n.forms.includes('delta'), true)
})

test('an in-app browser with no storage at all still negotiates', () => {
  const n = negotiate({ ...modern, sw: false, idb: false })
  assert.equal(n.residency, 'http-cache')
  assert.equal(
    n.downgrades.some((d) => d.includes('repeat-visit gains are not guaranteed')),
    true,
  )
})

test('a client offering only html is never sent a form it cannot project', () => {
  const n = negotiate({ warp: '1.0.0', ir: '1.0.0', forms: ['html'] })
  assert.deepEqual(n.forms, ['html'])
})

test('capabilities survive the RESIDENT round trip', () => {
  const parsed = readResident(residentFrame({ ...modern, rtt: 38, ect: '4g', cpu: 4, engine: 'WebKit/605' }))
  assert.equal(parsed.transport, 'stream')
  assert.equal(parsed.dsd, true)
  assert.equal(parsed.sw, true)
  assert.equal(parsed.rtt, 38)
  assert.equal(parsed.engine, 'WebKit/605')
})

test('the WARP frame states the versions and the strategy it settled on', () => {
  const f = warpFrame(negotiate({ ...modern, dsd: false }))
  assert.equal(f.kind, 'WARP')
  assert.equal(f.header.fill, 'script')
  assert.equal(f.header.v, WARP_VERSION)
  assert.match(String(f.header.downgrade), /filler script/)
})
