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
