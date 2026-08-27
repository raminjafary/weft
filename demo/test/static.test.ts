import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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
} from '@weftjs/core/server'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

/**
 * L0, against a real application.
 *
 * The unit of this feature is not a function, it is a page: whether *this* page is a file, and
 * whether the file says what the framework would have said. So the assertions are about the demo
 * — six shapes of page, several of which read nothing — and the property that matters is that the
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
    documents.map((d) => d.path).sort(),
    [
      '/',
      '/app/article',
      '/app/ordinary/household',
      '/app/ordinary/pantry',
      '/docs',
      '/docs/cache',
      '/docs/holes',
      '/docs/nesting',
    ],
    'the pages that read nothing, and the two parameterised ones that say what their parameter can be',
  )
  // A nested layout does not take a page out of the build-time set. The verdict is computed over
  // every layer of the chain, so these four are files because `app/layout.tsx`, the subtree's
  // layout and the page all read nothing — and a cookie read in any one of them would refuse all four.
  assert.deepEqual(
    documents.filter((d) => d.pattern === '/docs/:topic').map((d) => d.path),
    ['/docs/nesting', '/docs/holes', '/docs/cache'],
  )
  // One route, two documents, each proved on its own: an invariance test that passed for `pantry`
  // says nothing about `household`, and a loader that reads a cookie for one category and not the
  // other is exactly the bug that would otherwise be frozen into a file.
  assert.deepEqual(
    documents.filter((d) => d.pattern === '/app/ordinary/:category').map((d) => d.path),
    ['/app/ordinary/pantry', '/app/ordinary/household'],
  )
  assert.deepEqual(
    Object.fromEntries(refused.map((r) => [r.pattern, r.code])),
    {
      '/live/race/:order': 'L0_PARAMS',
      '/app/cart': 'L0_READS',
      // Not measured twice: what a region on another deployment reads is its own, and the registry
      // can be rolled without this build knowing, so two identical renders would prove nothing.
      '/app/composed': 'L0_REGION',
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
    const served = await fetch(new URL(document.path, serving.url))
    assert.equal(served.headers.get('x-weft-tier'), 'l0')
    assert.equal(Buffer.from(await served.arrayBuffer()).toString('utf8'), file.toString('utf8'))

    const held = app.documents.get(document.path)
    app.documents.delete(document.path)
    const rendered = await fetch(new URL(document.path, serving.url))
    app.documents.set(document.path, held as NonNullable<typeof held>)

    assert.equal(rendered.headers.get('x-weft-tier'), null, 'the fallthrough has to be the kernel')
    assert.equal(
      Buffer.from(await rendered.arrayBuffer()).toString('utf8'),
      file.toString('utf8'),
      `${document.path} differs between the render and the file`,
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
    documents.map((d) => d.path).sort(),
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

/**
 * The one refusal a route declares rather than the build deriving.
 *
 * Both halves of the L0 proof would say this page is a file: nothing it renders reads the request
 * where the compiler can see it, and its bytes are identical under both probes because neither one
 * invents the query key its loader reads. That is the hole `static: false` exists to close, and the
 * assertion worth making is that the declaration is *checked first* — before the derivations that
 * would otherwise overrule it.
 */
test('a route that declares it is not a file is refused with its own reason', async () => {
  const root = join(ROOT, 'test/fixtures/declared-dynamic')
  await rm(root, { recursive: true, force: true })
  try {
    await mkdir(join(root, 'app/routes'), { recursive: true })
    await writeFile(
      join(root, 'app/routes/index.data.ts'),
      `import { defineRoute } from '@weftjs/core'

export default defineRoute({
  head: { title: 'declared' },
  static: false,
  notStaticBecause: 'its body is whatever ?q carries, and no probe invents that key',
  slots: {
    body: { stream: false, html: (ctx) => \`<p>\${ctx.query('q') ?? 'nothing'}</p>\` },
  },
})
`,
    )
    const app = await createApp(root, { mode: 'dev', port: 0 })
    const route = app.routes.find((r) => r.pattern === '/')
    assert.deepEqual(route?.static, {
      static: false,
      code: 'L0_DECLARED',
      reason: 'its body is whatever ?q carries, and no probe invents that key',
    })

    const outcome = await prerender(app)
    assert.deepEqual(outcome.documents, [], 'a declared refusal may not be overruled by the probes')
    assert.equal(outcome.refused.find((entry) => entry.pattern === '/')?.code, 'L0_DECLARED')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
