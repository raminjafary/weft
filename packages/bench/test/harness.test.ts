import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkAll } from '../src/equivalence.ts'
import { segmentsCandidate } from '../src/candidates/segments.ts'
import { compileScenario } from '../src/compiled.ts'
import { stringSsrCandidate } from '../src/candidates/string-ssr.ts'
import { SCENARIOS, scenario } from '../src/workloads/index.ts'
import { measureBytes } from '../src/measure/bytes.ts'

const candidates = [segmentsCandidate, stringSsrCandidate]

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
