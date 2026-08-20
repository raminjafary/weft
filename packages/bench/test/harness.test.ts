import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkAll } from '../src/equivalence.ts'
import { segmentsCandidate } from '../src/candidates/segments.ts'
import { compileScenario } from '../src/compiled.ts'
import { stringSsrCandidate } from '../src/candidates/string-ssr.ts'
import { blockingSsrCandidate } from '../src/candidates/blocking-ssr.ts'
import { withLatency } from '../src/measure/latency.ts'
import { SCENARIOS, scenario } from '../src/workloads/index.ts'
import { measureBytes } from '../src/measure/bytes.ts'

const candidates = [segmentsCandidate, stringSsrCandidate, blockingSsrCandidate]

test('every wire form of every scenario produces identical bytes', async () => {
  for (const s of SCENARIOS) await compileScenario(s)
  const reports = await checkAll(SCENARIOS, candidates)
  for (const report of reports) {
    for (const check of report.checks) {
      assert.equal(check.ok, true, `${report.scenario}: ${check.name}\n${check.detail ?? ''}`)
    }
  }
})

test('a workload produces the same values every time it is asked', () => {
  const s = scenario('feed')
  assert.deepEqual(s.rows(), s.rows())
  assert.deepEqual(s.values(), s.values())
})

test('the delta form is smaller than data, which is smaller than html', async () => {
  const s = scenario('cart')
  await compileScenario(s)
  const rows = s.rows()
  const payloads = segmentsCandidate.updateForms!(s, s.values(), rows, s.transition(rows))
  const sizes = new Map(measureBytes(payloads).map((x) => [x.form, x.raw]))
  const delta = sizes.get('delta') as number
  const data = sizes.get('data') as number
  const html = sizes.get('html') as number
  assert.equal(delta < data, true, `delta ${delta} should be under data ${data}`)
  assert.equal(data < html, true, `data ${data} should be under html ${html}`)
})

test('a served document is identical whether the transport streams or buffers', async () => {
  const s = scenario('cart')
  await compileScenario(s)
  const streamed = await segmentsCandidate.serve!(s, { transport: 'stream' })
  const buffered = await segmentsCandidate.serve!(s, { transport: 'buffered' })
  try {
    const a = await (await fetch(streamed.url)).text()
    const b = await (await fetch(buffered.url)).text()
    assert.equal(a, b)
  } finally {
    await streamed.close()
    await buffered.close()
  }
})

test('a candidate that cannot serve a form says why instead of reporting zero', () => {
  assert.match(stringSsrCandidate.unsupported?.['update-bytes:delta'] ?? '', /base render/)
})

test('the latency proxy delays both directions', async () => {
  const s = scenario('cart')
  await compileScenario(s)
  const handle = await segmentsCandidate.serve!(s)
  const proxy = await withLatency(handle.url, { rttMs: 60 })
  try {
    const start = performance.now()
    const body = await (await fetch(proxy.url)).text()
    const elapsed = performance.now() - start
    assert.ok(elapsed >= 55, `expected at least one RTT, took ${elapsed.toFixed(1)}ms`)
    assert.equal(body, await (await fetch(handle.url)).text())
  } finally {
    await proxy.close()
    await handle.close()
  }
})

test('a slow hole does not delay the shell, but does delay a blocking response', async () => {
  const slow = scenario('slow-feed')
  assert.equal(slow.slowMs, 40)
  await compileScenario(slow)

  const streamed = await segmentsCandidate.serve!(slow)
  const blocking = await blockingSsrCandidate.serve!(slow)
  try {
    const first = await firstByteAndTotal(streamed.url)
    const second = await firstByteAndTotal(blocking.url)

    assert.ok(first.ttfb < 20, `streamed shell should arrive before the query resolves, took ${first.ttfb.toFixed(1)}ms`)
    assert.ok(first.total >= 38, `the body still waits for the query, took ${first.total.toFixed(1)}ms`)
    assert.ok(second.ttfb >= 38, `a blocking response cannot beat its own query, took ${second.ttfb.toFixed(1)}ms`)
  } finally {
    await streamed.close()
    await blocking.close()
  }
})

test('every candidate serving a scenario serves identical bytes', async () => {
  const s = scenario('feed')
  await compileScenario(s)
  const handles = await Promise.all(
    [segmentsCandidate, stringSsrCandidate, blockingSsrCandidate].map((c) => c.serve!(s)),
  )
  try {
    const bodies = await Promise.all(handles.map(async (h) => (await fetch(h.url)).text()))
    for (const body of bodies) assert.equal(body, bodies[0])
  } finally {
    await Promise.all(handles.map((h) => h.close()))
  }
})

async function firstByteAndTotal(url: string): Promise<{ ttfb: number; total: number }> {
  const start = performance.now()
  const response = await fetch(url)
  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  await reader.read()
  const ttfb = performance.now() - start
  for (;;) {
    const { done } = await reader.read()
    if (done) break
  }
  return { ttfb, total: performance.now() - start }
}
