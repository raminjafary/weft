import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { measureBudgets } from '../src/budget.ts'

/**
 * A byte budget only survives contact with a feature if exceeding it fails something.
 * This is that something.
 */
test('every entry stays inside its byte budget', async () => {
  const sizes = await measureBudgets()
  assert.equal(sizes.length > 0, true)
  for (const size of sizes) {
    assert.equal(
      size.within,
      true,
      `${size.id} is ${size.brotli} bytes brotli, over its ${size.limit} byte budget (${size.limitNote})`,
    )
  }
})

test('a content route does not pay for the update path it never uses', async () => {
  const sizes = await measureBudgets()
  const content = sizes.find((s) => s.id === 'content-route')
  const full = sizes.find((s) => s.id === 'runtime')
  assert.ok(content && full)
  assert.equal(
    content.brotli < full.brotli,
    true,
    `tree shaking should drop the delta and resident paths: ${content.brotli} vs ${full.brotli}`,
  )
})

/**
 * The specification's own table agrees with the last recorded run.
 *
 * `spec/kernel/budgets.md` prints a measured figure per entry, and those figures had drifted: every
 * kernel row was between 51 and 74 bytes behind, because a size moves whenever shared code does and
 * a hand-kept table only moves when somebody remembers. Nothing was wrong with the ceilings — the
 * gate above has always enforced those — but the numbers a reader was given to reason with were
 * stale, and there was no way to tell which.
 *
 * This is the same fix `spec/VERSIONING.md` got: the two are compared rather than trusted. Run
 * `pnpm bench budget --write` and update the table when it fails; the failure names the rows.
 *
 * It reads the recorded file rather than measuring, so the whole suite does not pay for a bundler.
 * The measuring is the test above.
 */
test('the specification quotes the sizes the last recorded run measured', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const recorded = JSON.parse(readFileSync(join(root, 'packages/bench/budgets.json'), 'utf8')) as {
    id: string
    brotli: number
  }[]
  const brotli = new Map(recorded.map((entry) => [entry.id, entry.brotli]))

  // Which helper an entry reaches through is which package it is in, so the same file name in the
  // server table and the client table resolves to two different entries.
  const source = readFileSync(join(root, 'packages/bench/src/budget.ts'), 'utf8')
  const ids = [...source.matchAll(/\n\s*id: '([^']+)',/g)]
  const byHelper: Record<string, Record<string, string>> = { kernelSrc: {}, src: {}, front: {} }
  for (const [at, match] of ids.entries()) {
    const chunk = source.slice(match.index ?? 0, ids[at + 1]?.index ?? source.length)
    const entry = /entry:\s*([a-zA-Z]+)\('([^']+)'\)/.exec(chunk)
    if (entry)
      (byHelper[entry[1] as string] as Record<string, string>)[entry[2] as string] = match[1] as string
  }

  const spec = readFileSync(join(root, 'spec/kernel/budgets.md'), 'utf8')
  const clientAt = spec.indexOf('On the client, same rule:')
  assert.ok(clientAt > 0, 'the sentence that separates the server table from the client one is still there')

  const stale: string[] = []
  let checked = 0
  for (const row of spec.matchAll(/\|\s*`([a-z-]+\.ts)`[^|]*\|[^|]*\|\s*([\d,]+) B\s*\|/g)) {
    const [, file, said] = row
    const helper = file === 'boot.ts' ? 'front' : (row.index ?? 0) < clientAt ? 'kernelSrc' : 'src'
    const id = (byHelper[helper] as Record<string, string>)[file as string]
    const now = id ? brotli.get(id) : undefined
    if (now === undefined) continue
    checked++
    const was = Number((said as string).replaceAll(',', ''))
    if (was !== now) stale.push(`${file}: table says ${was}, the run measured ${now}`)
  }

  assert.ok(checked > 10, `only ${checked} rows were checked; the table's shape has changed`)
  assert.deepEqual(stale, [], 'run `pnpm bench budget --write` and update spec/kernel/budgets.md')
})

/**
 * And every other document that quotes one of those sizes.
 *
 * The test above holds `spec/kernel/budgets.md`, and that is exactly why that file was the only one
 * still correct: eight other documents quoted the same per-entry figures and every one of them had
 * drifted, some by thousands of bytes. `spec/kernel/composition.md` said `entry-region-channel.ts`
 * was 11,264 B against a measured 16,828, and `packages/weft/README.md` — the repository's front
 * page — carried a kernel figure the documentation site had already stopped agreeing with.
 *
 * The rule is deliberately loose about columns, because these tables do not share a shape: one puts
 * the ceiling beside the measurement, one puts a description between them, and two are prose. What
 * it asks is only that a passage naming an entry file, and quoting bytes at all, quotes the measured
 * number somewhere in it. A two-line window, because prose wraps.
 */
const QUOTES = [
  'DESIGN.md',
  'README.md',
  'spec/FINDINGS.md',
  'spec/kernel/ports.md',
  'spec/kernel/authority.md',
  'spec/kernel/composition.md',
  'packages/weft/README.md',
  'packages/client/README.md',
]

test('every document quoting an entry size quotes the one that was measured', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const recorded = JSON.parse(readFileSync(join(root, 'packages/bench/budgets.json'), 'utf8')) as {
    id: string
    brotli: number
  }[]
  const brotli = new Map(recorded.map((entry) => [entry.id, entry.brotli]))

  const source = readFileSync(join(root, 'packages/bench/src/budget.ts'), 'utf8')
  const byFile = new Map<string, string>()
  const ids = [...source.matchAll(/\n\s*id: '([^']+)',/g)]
  for (const [at, match] of ids.entries()) {
    const chunk = source.slice(match.index ?? 0, ids[at + 1]?.index ?? source.length)
    const entry = /entry:\s*[a-zA-Z]+\('([^']+)'\)/.exec(chunk)
    // Only the server entries are named by file in prose; a client file name collides with one.
    if (entry && (entry[1] as string).startsWith('entry-') && /kernelSrc\(/.test(chunk)) {
      byFile.set(entry[1] as string, match[1] as string)
    }
  }

  const stale: string[] = []
  let checked = 0
  for (const file of QUOTES) {
    const lines = readFileSync(join(root, file), 'utf8').split('\n')
    for (const [at, line] of lines.entries()) {
      for (const mention of line.matchAll(/`(entry-[a-z-]+\.ts)`/g)) {
        const id = byFile.get(mention[1] as string)
        const now = id ? brotli.get(id) : undefined
        if (now === undefined) continue
        const window = `${line}\n${lines[at + 1] ?? ''}`
        if (!/[\d,]{4,} ?B\b/.test(window)) continue
        checked++
        if (!window.includes(now.toLocaleString('en-US'))) {
          stale.push(`${file}:${at + 1} names ${mention[1]}, whose measured size is ${now}`)
        }
      }
    }
  }

  assert.ok(checked > 8, `only ${checked} quotations were checked; a document may have moved`)
  assert.deepEqual(stale, [], 'run `pnpm bench budget --write`, then update the documents named')
})

/**
 * The tables that name an entry in prose rather than by file.
 *
 * `packages/weft/README.md` says "Server kernel, the document request path" where the specification
 * says `entry-request.ts`, so the check above walked straight past the repository's own front page —
 * which was carrying an 8,118 the documentation site had already corrected. The mapping is stated
 * rather than matched, because these labels are written for a reader and three documents word the
 * same row three different ways; a fuzzy match here would be a test that passes for the wrong reason.
 */
const LABELLED: readonly (readonly [string, string])[] = [
  ['Client runtime, everything', 'runtime'],
  ['Content route — adopt and bind', 'content-route'],
  ['App route — adopt, bind, patch, epochs', 'app-route'],
  ['Channel route — plus routing frames', 'channel-route'],
  ['Patching route — plus applying a patch', 'patch-route'],
  ['Navigating route — plus staged routes', 'nav-route'],
  ['Front door — the code, bundled', 'front-door'],
  ['Server kernel — the document request path', 'kernel'],
  ['Server kernel, the document request path', 'kernel'],
  ['Kernel + intent dispatch', 'kernel-intent'],
  ['Kernel + surgical refresh and epochs', 'kernel-refresh'],
  ['Kernel + the patch encoder', 'kernel-patch'],
  ['Kernel + authority', 'kernel-authority'],
  ['Kernel + composition', 'kernel-region'],
  ['Kernel + a live Warp channel', 'kernel-transport'],
  ['Kernel + composition over a live channel', 'kernel-region-channel'],
  ['The whole runtime is', 'runtime'],
]

test('a table that names an entry in prose quotes the measured size too', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const recorded = JSON.parse(readFileSync(join(root, 'packages/bench/budgets.json'), 'utf8')) as {
    id: string
    brotli: number
  }[]
  const brotli = new Map(recorded.map((entry) => [entry.id, entry.brotli]))

  const stale: string[] = []
  let checked = 0
  for (const file of QUOTES) {
    const lines = readFileSync(join(root, file), 'utf8').split('\n')
    for (const [at, line] of lines.entries()) {
      const cell = line.startsWith('|') ? (line.split('|')[1] ?? '').trim() : undefined
      for (const [label, id] of LABELLED) {
        if (cell === undefined ? !line.includes(label) : cell !== label) continue
        const now = brotli.get(id)
        if (now === undefined || !/\*\*[\d,]{4,}/.test(line)) continue
        checked++
        if (!line.includes(now.toLocaleString('en-US'))) {
          stale.push(`${file}:${at + 1} is the ${id} row, whose measured size is ${now}`)
        }
      }
    }
  }

  assert.ok(checked > 15, `only ${checked} rows were checked; a table may have been reworded`)
  assert.deepEqual(stale, [], 'run `pnpm bench budget --write`, then update the rows named')
})
