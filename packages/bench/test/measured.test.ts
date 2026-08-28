import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readMeasured } from '../src/measured.ts'
import type { SlotRun } from '../src/measure/slots.ts'
import type { SharedDeltaReport } from '../src/measure/shared-delta.ts'
import type { NavReport } from '../src/measure/navigation.ts'
import type { L0Report } from '../src/measure/l0.ts'

/**
 * The five commands that are not axes, and the documents that quote them.
 *
 * `budget.test.ts` holds every document quoting a byte budget to `budgets.json`, and that mechanism
 * is the reason those figures are correct: the one file it did not cover was the one file that had
 * drifted. This is the same mechanism over `measured.json`, and it exists because the same thing
 * had happened again, one level out.
 *
 * `slots`, `deltas`, `nav`, `l0` and `decode` printed to a terminal and wrote nothing. Nine
 * documents quoted their figures — the streaming race, the thousand-client diff, the staged click,
 * the served document — and there was no file to check them against, so they were transcribed once
 * and never again. Recording the runs made checking them possible; this is the check.
 *
 * It asserts presence rather than parsing tables, deliberately. These passages do not share a
 * shape: two are tables with different columns, three are prose, and one is a sentence with the
 * two numbers a paragraph apart. What every one of them has in common is that the measured figure
 * has to appear somewhere in it, and a figure that does not is a figure a reader cannot trust.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

function p50(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? NaN
}

function section<T>(key: string): T {
  const held = readMeasured()[key]
  assert.ok(held, `measured.json has no '${key}' section — run \`pnpm bench ${key} --write\``)
  return held.measured as T
}

/** What the document has to say somewhere, and the name to print when it does not. */
interface Claim {
  what: string
  text: string
}

function holds(files: readonly string[], claims: readonly Claim[]): void {
  const missing: string[] = []
  for (const file of files) {
    const body = readFileSync(join(ROOT, file), 'utf8')
    for (const claim of claims) {
      if (!body.includes(claim.text)) missing.push(`${file} does not say ${claim.what}: ${claim.text}`)
    }
  }
  assert.deepEqual(missing, [], 'a measured figure moved; update the documents named')
}

test('every document quoting the streaming race quotes the run that measured it', () => {
  const slots = section<{ filler: number; runs: SlotRun[] }>('slots')
  const chromium = slots.runs.find((run) => run.engine === 'chromium')
  assert.ok(chromium, 'the slots run has no chromium in it')

  const inOrder = p50(chromium.inOrder.map((times) => times.recs))
  const outOfOrder = p50(chromium.outOfOrder.map((times) => times.recs))
  holds(
    ['README.md', 'spec/kernel/streaming.md', 'spec/FINDINGS.md'],
    [
      { what: 'the in-order fast region in Chromium', text: `${inOrder.toFixed(0)} ms` },
      { what: 'the out-of-order fast region in Chromium', text: `${outOfOrder.toFixed(0)} ms` },
    ],
  )
  holds(
    ['spec/kernel/streaming.md'],
    [{ what: 'the inline script the fill costs', text: `${slots.filler} bytes` }],
  )
})

/**
 * The thousand-client diff, including the block where the shared path loses.
 *
 * Both halves are checked on purpose. The first is the claim; the second is the case it does not
 * cover, and a document that quotes the win and drops the loss is advocacy rather than measurement.
 */
test('every document quoting the shared refresh quotes both blocks of it', () => {
  const reports = section<SharedDeltaReport[]>('deltas')
  const feed = reports.find((report) => report.scenario === 'feed')
  assert.ok(feed, 'the deltas run has no feed scenario in it')

  const at = (strategy: string, arrival: string): string => {
    const found = feed.results.find((r) => r.strategy === strategy && r.arrival === arrival)
    assert.ok(found, `no ${strategy}/${arrival} result`)
    return found.ms.toFixed(1)
  }
  holds(
    ['README.md', 'spec/kernel/surgical.md', 'spec/FINDINGS.md'],
    [
      { what: 'the shared cost on one base', text: at('shared', 'aligned') },
      { what: 'the per-connection cost on one base', text: at('per-connection', 'aligned') },
      { what: 'the shared cost on staggered bases', text: at('shared', 'staggered') },
      { what: 'the per-connection cost on staggered bases', text: at('per-connection', 'staggered') },
    ],
  )
})

/**
 * The staged click, on the page where staging is unambiguously worth it.
 *
 * The dashboard rather than an average: it is the one route in the demo whose slots are slow on
 * purpose, so it is the only row where the ratio is about the mechanism rather than about how fast
 * loopback is. The loopback rows where staging *loses* are in the specification's table, and the
 * test above says why that matters.
 */
test('every document quoting a staged navigation quotes the run that measured it', () => {
  const reports = section<NavReport[]>('nav')
  const chromium = reports.find((report) => report.engine === 'chromium')
  assert.ok(chromium, 'the nav run has no chromium in it')

  const slow = chromium.pairs.find((pair) => pair.to.includes('dashboard'))
  assert.ok(slow, 'the nav run did not click the dashboard, which is the slow page')
  holds(
    ['README.md', 'spec/client/navigation.md'],
    [
      { what: 'the staged click on the slow page', text: `${slow.staged.summary.p50.toFixed(1)} ms` },
      { what: 'the same click handed to the browser', text: `${slow.browser.summary.p50.toFixed(1)} ms` },
    ],
  )
})

/**
 * Every row of the L0 table, and the byte count each row is about.
 *
 * Both halves, because they drift independently: a route's size moves when its markup does, and
 * the ratio moves when either path does. The table said 4,332 B for `/` long after the document
 * had grown past six thousand, which is the more misleading of the two — a ratio a reader might
 * treat as approximate, a byte count reads as exact.
 */
test('every row of the L0 table is a row of the run that measured it', () => {
  const reports = section<L0Report[]>('l0')
  assert.ok(Array.isArray(reports) && reports.length > 0, 'the l0 section holds no reports')

  const claims: Claim[] = []
  for (const report of reports) {
    const ratio = (report.kernel.ttlb.p50 / report.l0.ttlb.p50).toFixed(2)
    claims.push(
      { what: `the bytes of ${report.path}`, text: report.bytes.toLocaleString('en-US') },
      { what: `what the kernel costs over the file for ${report.path}`, text: `${ratio}×` },
    )
  }
  holds(['spec/kernel/static.md'], claims)
})

/**
 * And the axes, held to the run this repository ships.
 *
 * `results/` is gitignored except for the runs the site and the README cite, on the rule that a
 * repository stating a measurement ships the measurement it states. That made the figures
 * reproducible and still left them transcribed: the README's client-runtime table, its throughput
 * table and its boot-path table are three tables of numbers a person copied out of a terminal.
 *
 * Every one of them had drifted. Adoption was quoted at 0.044/0.105/0.050 against a run that had
 * measured 0.044/0.1/0.045; throughput was a run old enough that its slowest ratio had moved by
 * half. None of it was wrong on purpose and none of it could be noticed, which is the argument for
 * a test rather than for more care.
 */
function published(): Map<string, number> {
  const dir = fileURLToPath(new URL('../../../results/', import.meta.url))
  const figures = new Map<string, number>()
  for (const name of readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()) {
    const raw = JSON.parse(readFileSync(join(dir, name), 'utf8')) as {
      rows: {
        axis: string
        scenario: string
        candidate: string
        engine?: string
        status: string
        summary?: { p50: number }
      }[]
    }
    for (const row of raw.rows) {
      if (row.status !== 'measured' || !row.summary) continue
      figures.set(`${row.axis}|${row.scenario}|${row.candidate}|${row.engine ?? ''}`, row.summary.p50)
    }
  }
  return figures
}

test('the README quotes the axes at the values the shipped run measured', () => {
  const figures = published()
  const at = (key: string): number => {
    const found = figures.get(key)
    assert.ok(found !== undefined, `no committed run measured ${key}`)
    return found
  }

  const claims: Claim[] = []
  for (const engine of ['chromium', 'firefox', 'webkit']) {
    const adopt = at(`tti-server-rendered|feed|adopt a server-rendered region|${engine}`)
    const parse = at(`client-work|feed|html form, parsed|${engine}`)
    const apply = at(`client-work|feed|delta form, applied surgically|${engine}`)
    const write = at(`isolated-dom-update|derived|one signal write to one node|${engine}`)
    claims.push(
      { what: `adoption in ${engine}`, text: `${round(adopt)} ms` },
      { what: `the parse in ${engine}`, text: `${round(parse)} ms` },
      { what: `the delta applied in ${engine}`, text: `${round(apply)} ms` },
      { what: `one signal write in ${engine}`, text: `${(write * 1000).toFixed(2)} µs` },
    )
  }
  for (const scenario of ['shell', 'cart', 'feed']) {
    claims.push(
      {
        what: `${scenario} throughput with segments`,
        text: Math.round(at(`server-throughput|${scenario}|segments|`)).toLocaleString('en-US'),
      },
      {
        what: `${scenario} throughput with string SSR`,
        text: Math.round(at(`server-throughput|${scenario}|string-ssr|`)).toLocaleString('en-US'),
      },
    )
  }
  holds(
    ['README.md', 'spec/client/adoption.md'],
    claims.filter((claim) => claim.text.includes('ms') || claim.text.includes('µs')),
  )
  holds(['README.md'], claims)
})

/** The way `lib/bench.ts` prints a figure, so the page and the document agree digit for digit. */
function round(value: number): string {
  const digits = value < 0.01 ? 4 : value < 1 ? 3 : value < 10 ? 2 : 1
  return value.toLocaleString('en-US', { maximumFractionDigits: digits })
}
