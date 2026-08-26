import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkAll } from '../src/equivalence.ts'
import { segmentsCandidate } from '../src/candidates/segments.ts'
import { compileScenario } from '../src/compiled.ts'
import { stringSsrCandidate } from '../src/candidates/string-ssr.ts'
import { blockingSsrCandidate } from '../src/candidates/blocking-ssr.ts'
import { describeLink, withLink } from '../src/measure/link.ts'
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

test('the delta form is the only one smaller than html after compression', async () => {
  const s = scenario('cart')
  await compileScenario(s)
  const rows = s.rows()
  const payloads = segmentsCandidate.updateForms!(s, s.values(), rows, s.transition(rows))
  const sizes = measureBytes(payloads)
  assert.deepEqual(
    sizes.map((x) => x.form).sort(),
    ['delta', 'html'],
    'the data form was cut; nothing should still emit it',
  )
  const delta = sizes.find((x) => x.form === 'delta')
  const html = sizes.find((x) => x.form === 'html')
  assert.ok(delta && html)
  assert.equal(delta.raw < html.raw, true, `delta ${delta.raw} should be under html ${html.raw}`)
  assert.equal(
    delta.brotli < html.brotli,
    true,
    `the win has to survive brotli: ${delta.brotli} vs ${html.brotli}`,
  )
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

test('the link proxy delays both directions', async () => {
  const s = scenario('cart')
  await compileScenario(s)
  const handle = await segmentsCandidate.serve!(s)
  const proxy = await withLink(handle.url, { rttMs: 60 })
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

test('a rate-limited link charges for bytes, and charges more for more of them', async () => {
  const s = scenario('feed')
  await compileScenario(s)
  const handle = await segmentsCandidate.serve!(s)
  const fast = await withLink(handle.url, { rttMs: 0, kbps: 4_000 })
  const slow = await withLink(handle.url, { rttMs: 0, kbps: 400 })
  try {
    const expected = await (await fetch(handle.url)).text()
    const bytes = Buffer.byteLength(expected)

    const timed = async (url: string): Promise<number> => {
      const start = performance.now()
      assert.equal(await (await fetch(url)).text(), expected)
      return performance.now() - start
    }

    const quick = await timed(fast.url)
    const crawl = await timed(slow.url)

    // Serialization at 400 kbps is 50 bytes per millisecond, so the floor is arithmetic and
    // not a guess. Slow start is in there too, which only makes the real figure larger.
    const floor = bytes / 50
    assert.ok(
      crawl >= floor * 0.8,
      `${bytes} B at 400 kbps took ${crawl.toFixed(1)}ms, floor ~${floor.toFixed(0)}ms`,
    )
    assert.ok(
      crawl > quick * 2,
      `a tenth of the bandwidth should cost much more than ${quick.toFixed(1)}ms, took ${crawl.toFixed(1)}ms`,
    )
  } finally {
    await fast.close()
    await slow.close()
    await handle.close()
  }
})

test('loss stalls the stream behind the hole, and the same seed loses in the same places', async () => {
  const s = scenario('feed')
  await compileScenario(s)
  const handle = await segmentsCandidate.serve!(s)
  const clean = await withLink(handle.url, { rttMs: 10, kbps: 2_000 })
  const lossy = await withLink(handle.url, { rttMs: 10, kbps: 2_000, lossPercent: 20, seed: 7 })
  const again = await withLink(handle.url, { rttMs: 10, kbps: 2_000, lossPercent: 20, seed: 7 })
  try {
    const expected = await (await fetch(handle.url)).text()
    const timed = async (url: string): Promise<number> => {
      const start = performance.now()
      assert.equal(await (await fetch(url)).text(), expected)
      return performance.now() - start
    }

    const without = await timed(clean.url)
    const first = await timed(lossy.url)
    const second = await timed(again.url)

    // An RTO is floored at 200 ms, so one loss is visible against a link this fast.
    assert.ok(
      first > without + 150,
      `loss should stall: ${without.toFixed(1)}ms clean, ${first.toFixed(1)}ms lossy`,
    )
    assert.ok(
      Math.abs(first - second) < first * 0.5,
      `the same seed should lose in the same places: ${first.toFixed(1)}ms then ${second.toFixed(1)}ms`,
    )
  } finally {
    await clean.close()
    await lossy.close()
    await again.close()
    await handle.close()
  }
})

test('a link says what it modelled, including when it modelled nothing', () => {
  assert.match(describeLink({ rttMs: 0 }), /no network was modelled/)
  assert.equal(describeLink({ rttMs: 40 }), '40 ms RTT, unlimited bandwidth, no loss')
  assert.equal(
    describeLink({ rttMs: 100, kbps: 400, lossPercent: 2 }),
    '100 ms RTT, 400 kbps each way, 2% packet loss',
  )
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

    assert.ok(
      first.ttfb < 20,
      `streamed shell should arrive before the query resolves, took ${first.ttfb.toFixed(1)}ms`,
    )
    assert.ok(first.total >= 38, `the body still waits for the query, took ${first.total.toFixed(1)}ms`)
    assert.ok(
      second.ttfb >= 38,
      `a blocking response cannot beat its own query, took ${second.ttfb.toFixed(1)}ms`,
    )
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
