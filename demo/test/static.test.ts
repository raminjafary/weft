import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  build,
  createApp,
  discover,
  loadBuild,
  loadConfig,
  prerender,
  serveApp,
  type App,
  type BuildReport,
  type Serving,
} from 'weft/server'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

/**
 * L0, against a real application.
 *
 * The unit of this feature is not a function, it is a page: whether *this* page is a file, and
 * whether the file says what the framework would have said. So the assertions are about the demo
 * — five shapes of page, two of which read nothing — and the property that matters is that the
 * tier is invisible. A visitor who gets the file and a visitor who gets the render are looking at
 * the same bytes; only the headers admit which happened.
 */
let report: BuildReport | null = null

async function built(): Promise<BuildReport> {
  report ??= await build(ROOT)
  return report
}

const servers: Serving[] = []

/** The deployment: sealed templates read back from the build, and no compiler. */
async function start(): Promise<App> {
  await built()
  const config = await loadConfig(ROOT, {})
  const discovered = await discover(ROOT, config.srcDir)
  return createApp(ROOT, { mode: 'start', compiled: await loadBuild(discovered, config), port: 0 })
}

after(async () => {
  for (const serving of servers) await serving.close()
})

test('the pages that read nothing are files, and the rest say why they are not', async () => {
  const { static: documents, refused } = await built()

  assert.deepEqual(
    documents.map((d) => d.pattern).sort(),
    ['/', '/app/article'],
    'the index and the article are the demo pages that read nothing',
  )
  assert.deepEqual(
    Object.fromEntries(refused.map((r) => [r.pattern, r.code])),
    {
      '/app/ordinary/:category': 'L0_PARAMS',
      '/live/race/:order': 'L0_PARAMS',
      '/app/cart': 'L0_READS',
      '/app/dashboard': 'L0_OUT_OF_ORDER',
      '/app/feed': 'L0_READS',
    },
    'every page that is not a file is refused by name, because a tier nobody can see is a tier nobody uses',
  )
  for (const refusal of refused) {
    assert.ok(refusal.reason.length > 30, `${refusal.pattern} is refused without saying why`)
  }
})

/**
 * The gate the whole tier rests on, and the reason it is asserted from the same server.
 *
 * A dev render is not the comparison to make: dev serves stable asset URLs that must never cache
 * and a build serves revved ones, so the two documents differ for a reason that has nothing to do
 * with L0. What has to be identical is the pair a visitor could actually get — the file, and what
 * this same deployment would have rendered if the file were not there. So one entry is removed
 * from the table and the request falls through to the kernel.
 */
test('the file the build wrote is byte-for-byte what the kernel would have rendered', async () => {
  const { outDir, static: documents } = await built()
  const app = await start()
  const serving = await serveApp(app)
  servers.push(serving)

  for (const document of documents) {
    const file = await readFile(join(ROOT, outDir, 'static', document.file))
    const served = await fetch(new URL(document.pattern, serving.url))
    assert.equal(served.headers.get('x-weft-tier'), 'l0')
    assert.equal(Buffer.from(await served.arrayBuffer()).toString('utf8'), file.toString('utf8'))

    const held = app.documents.get(document.pattern)
    app.documents.delete(document.pattern)
    const rendered = await fetch(new URL(document.pattern, serving.url))
    app.documents.set(document.pattern, held as NonNullable<typeof held>)

    assert.equal(rendered.headers.get('x-weft-tier'), null, 'the fallthrough has to be the kernel')
    assert.equal(
      Buffer.from(await rendered.arrayBuffer()).toString('utf8'),
      file.toString('utf8'),
      `${document.pattern} differs between the render and the file`,
    )
  }
})

test('weft start answers an L0 path without the kernel, and a conditional one without the bytes', async () => {
  const { static: documents } = await built()
  const app = await start()
  const serving = await serveApp(app)
  servers.push(serving)

  assert.deepEqual(
    [...app.documents.keys()].sort(),
    documents.map((d) => d.pattern).sort(),
    'start loads exactly the documents the build wrote',
  )

  const first = await fetch(new URL('/app/article', serving.url))
  const etag = first.headers.get('etag')
  assert.equal(first.status, 200)
  assert.equal(first.headers.get('x-weft-tier'), 'l0')
  assert.ok(etag, 'a document that cannot change should offer a way not to send it twice')
  assert.equal(
    first.headers.get('cache-control'),
    'public, max-age=0, must-revalidate',
    'a route with no declared policy still may be held, because the build proved it cannot vary',
  )

  const second = await fetch(new URL('/app/article', serving.url), {
    headers: { 'if-none-match': etag as string },
  })
  assert.equal(second.status, 304)
  assert.equal((await second.arrayBuffer()).byteLength, 0)

  // A page that reads something is still the kernel's, and says nothing about a tier.
  const rendered = await fetch(new URL('/app/feed', serving.url))
  assert.equal(rendered.status, 200)
  assert.equal(rendered.headers.get('x-weft-tier'), null)
})

/**
 * The half the effect set cannot decide.
 *
 * A cookie read from a route's own declaration is invisible to the compiler — a `.data.ts` is not
 * compiled — so nothing structural refuses these pages. What refuses them is the render itself:
 * two requests that differ only in what a static document may not depend on, and bytes that came
 * out different. The fixtures are two files, each named for the case it demonstrates.
 */
test('a page the compiler cannot see through is refused by the render that proves it', async () => {
  const root = join(ROOT, 'test/fixtures/untracked')
  const app = await createApp(root, { mode: 'dev', port: 0 })

  for (const route of app.routes) {
    assert.deepEqual(
      route.static,
      { static: true },
      `${route.pattern} is structurally static, which is exactly the problem`,
    )
  }

  const outcome = await prerender(app)
  assert.deepEqual(outcome.documents, [], 'neither fixture may become a file')

  const byPattern = Object.fromEntries(outcome.refused.map((entry) => [entry.pattern, entry]))
  assert.equal(byPattern['/hidden-read']?.code, 'L0_VARIES')
  assert.match(
    byPattern['/hidden-read']?.reason ?? '',
    /a cookie/,
    'the refusal has to name what the document turned out to depend on',
  )
  assert.equal(byPattern['/degrades']?.code, 'L0_DEGRADED')
  assert.match(byPattern['/degrades']?.reason ?? '', /this loader cannot run/)
})
