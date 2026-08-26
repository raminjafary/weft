import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/serve.ts'
import { checkJsBudgets, describeJsVerdict, measureClientJs } from '../src/js-budget.ts'
import type { GeneratedRoute } from '../src/routes.ts'

const ROOT = fileURLToPath(new URL('../../../demo/', import.meta.url))

let built: Awaited<ReturnType<typeof createApp>> | null = null
async function app(): Promise<NonNullable<typeof built>> {
  built ??= await createApp(ROOT, { mode: 'build', port: 0 })
  return built
}

/**
 * What a page downloads, and the reason this is measured by walking rather than by bundling.
 *
 * There is no bundler here. A page loads the boot module and whatever that module imports, each one
 * as its own response, so the number a reader pays is the sum of individually-compressed modules —
 * not the size of a bundle nothing produces. The bench's `front-door` entry measures the bundled
 * figure, which is a useful gate on how much *code* there is and is not what anybody downloads.
 */
test('the client is measured as the browser fetches it: module by module, compressed each', async () => {
  const measured = await measureClientJs((await app()).assets, (await app()).assets.app)
  assert.ok(measured.modules.length > 10, `${measured.modules.length} modules, each its own response`)
  assert.ok(
    measured.modules.every((module) => module.brotli > 0 && module.raw > 0),
    'every module was found and compressed',
  )
  // Not every module gets smaller: a fifty-byte re-export compresses to more than it was, because
  // a brotli stream has a header and a barrel file has nothing to find. It is a real cost of
  // serving modules rather than a bundle, and it is in the total rather than smoothed out of it.
  assert.ok(
    measured.modules.some((module) => module.brotli >= module.raw),
    'and the small ones say what per-module compression costs',
  )
  assert.equal(
    measured.brotli,
    measured.modules.reduce((sum, module) => sum + module.brotli, 0),
    'the total is the sum of what each response costs, because that is how they arrive',
  )
  // The boot module is the largest single thing a page fetches, and it is not close.
  const largest = [...measured.modules].sort((a, b) => b.brotli - a.brotli)[0]
  assert.match(largest?.href ?? '', /boot/)
})

function routeWith(budget: { jsBytes?: number; growBytes?: number }): GeneratedRoute {
  return {
    pattern: '/priced',
    plan: { slots: [{ name: 'body', budget }] },
  } as unknown as GeneratedRoute
}

test('a declared ceiling the client exceeds fails the build, and says whose number it is', async () => {
  const measured = await measureClientJs((await app()).assets, (await app()).assets.app)
  const broken = checkJsBudgets([routeWith({ jsBytes: 1_024 })], measured)
  assert.equal(broken.length, 1)
  assert.equal(broken[0]?.kind, 'ceiling')
  assert.equal(broken[0]?.measured, measured.brotli)
  const said = describeJsVerdict(broken[0]!)
  assert.match(said, /E_JS_BUDGET/)
  assert.match(said, /\/priced/)
  // The attribution is refused rather than guessed: without a bundler the excess is not the
  // slot's, and a message that implied otherwise would send somebody looking in the wrong file.
  assert.match(said, /no bundler here, so this is the whole application's client/)
})

test('a ceiling the client is inside is silent, which is the only way a gate stays on', async () => {
  const measured = await measureClientJs((await app()).assets, (await app()).assets.app)
  assert.deepEqual(checkJsBudgets([routeWith({ jsBytes: measured.brotli + 1 })], measured), [])
})

test('a growth cap is measured against a recorded figure, and absent one it says nothing', async () => {
  const measured = await measureClientJs((await app()).assets, (await app()).assets.app)
  const route = routeWith({ growBytes: 100 })

  assert.deepEqual(checkJsBudgets([route], measured), [], 'a first build has nothing to grow against')

  const drifted = checkJsBudgets([route], measured, measured.brotli - 500)
  assert.equal(drifted.length, 1)
  assert.equal(drifted[0]?.kind, 'growth')
  assert.match(describeJsVerdict(drifted[0]!), /E_JS_GROWTH/)

  assert.deepEqual(
    checkJsBudgets([route], measured, measured.brotli - 50),
    [],
    'fifty bytes against a hundred-byte cap is drift the cap allows',
  )
})

test('the demo declares one, and the build it declares it for passes', async () => {
  const declared = (await app()).routes
    .flatMap((route) => route.plan.slots)
    .map((slot) => slot.budget?.jsBytes)
    .filter((bytes): bytes is number => bytes !== undefined)
  assert.ok(declared.length > 0, 'the demo declares a client budget, so this gate is exercised')
  const measured = await measureClientJs((await app()).assets, (await app()).assets.app)
  assert.ok(
    measured.brotli < Math.min(...declared),
    `the demo downloads ${measured.brotli} B against its own ${Math.min(...declared)} B`,
  )
})
