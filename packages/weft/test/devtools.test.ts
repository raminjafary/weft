import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { cookieSession, staticFlags } from '@weft/adapters'
import { byteReport, devtoolsFor, fragmentReport, routeReport, whyPage } from '../src/devtools.ts'
import { createApp, serveApp, type App, type Serving } from '../src/serve.ts'

/**
 * Devtools, pointed at a real application.
 *
 * The demo is the application, built the way `weft dev` builds it, because the whole claim
 * being tested is that these pages read an `App` object rather than fixtures of their own — and
 * a test that handed devtools a hand-made `App` would be testing the fixture. The assertions
 * are deliberately structural: which routes exist and what they read belongs to the demo, and a
 * devtools test that pinned either would break every time somebody edited a page.
 */
const ROOT = fileURLToPath(new URL('../../../demo/', import.meta.url))

let on: App | null = null

async function app(): Promise<App> {
  on ??= await createApp(ROOT, { mode: 'dev', devtools: true, port: 0 })
  return on
}

async function serving(options: { devtools: boolean }): Promise<Serving> {
  return serveApp(await createApp(ROOT, { mode: 'dev', devtools: options.devtools, port: 0 }))
}

test('devtools is off unless it is asked for, and refuses to be anything but dev', async () => {
  const enabled = await app()
  assert.equal(devtoolsFor({ ...enabled, config: { ...enabled.config, devtools: false } }), null)

  // `weft start` serves a build. A deployment answering what its own cache keys are made of is
  // not a smaller version of a development convenience, so it is refused by name rather than
  // quietly ignored. `weft build` never calls `serveApp`, so it never reaches this at all.
  assert.throws(() => devtoolsFor({ ...enabled, mode: 'start' }), /E_DEVTOOLS_NOT_DEV/)
  assert.throws(() => devtoolsFor({ ...enabled, mode: 'build' }), /E_DEVTOOLS_NOT_DEV/)
})

test('every page renders, is never stored, and an unknown one is refused by name', async () => {
  const server = await serving({ devtools: true })
  try {
    for (const page of ['', '/routes', '/why', '/fragments', '/intents', '/bytes']) {
      const response = await fetch(new URL(`/_weft/devtools${page}`, server.url))
      assert.equal(response.status, 200, `/_weft/devtools${page}`)
      assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8')
      assert.equal(response.headers.get('cache-control'), 'no-store')
      const html = await response.text()
      assert.match(html, /^<!doctype html>/)
      assert.ok(html.includes('weft devtools'), `/_weft/devtools${page} rendered no chrome`)
    }

    const missing = await fetch(new URL('/_weft/devtools/profile', server.url))
    assert.equal(missing.status, 404)
    assert.match(await missing.text(), /E_NO_SUCH_PAGE/)

    // A path that merely starts with the same characters is not devtools' to answer.
    assert.equal((await fetch(new URL('/_weft/devtoolsish', server.url))).status, 404)
  } finally {
    await server.close()
  }
})

test('with devtools off there is no route to find', async () => {
  const server = await serving({ devtools: false })
  try {
    const response = await fetch(new URL('/_weft/devtools', server.url))
    assert.equal(response.status, 404)
    assert.ok(!(await response.text()).includes('weft devtools'), 'devtools answered while off')
  } finally {
    await server.close()
  }
})

test('the route report is the generated plan, not a second reading of the file tree', async () => {
  const report = routeReport(await app())
  const built = await app()
  assert.deepEqual(
    report.map((route) => route.pattern),
    built.routes.map((route) => route.pattern),
  )
  for (const route of report) {
    const generated = built.routes.find((candidate) => candidate.pattern === route.pattern)
    assert.ok(generated)
    assert.equal(route.plan, generated.plan, 'the report holds the plan itself, not a copy of it')
    assert.deepEqual(
      route.live.map((region) => region.slot),
      Object.keys(generated.live),
    )
    // A slot that names a fragment has the compiler's facts for it, which is what makes the
    // cache class on the page the one the kernel will use.
    for (const slot of route.slots) {
      if (!slot.spec.fragment) continue
      assert.ok(slot.facts, `${route.pattern} ${slot.spec.name} lost its compiled facts`)
      assert.equal(slot.facts.id, slot.spec.fragment)
    }
  }
})

test('every compiled fragment is reported with the version it was sealed at', async () => {
  const built = await app()
  const report = fragmentReport(built)
  assert.deepEqual(
    report.map((fragment) => fragment.name).sort(),
    Object.keys(built.compiled.fragments).sort(),
  )
  for (const fragment of report) {
    const compiled = built.compiled.fragments[fragment.name]
    assert.ok(compiled)
    assert.equal(fragment.version, compiled.entry.version)
    assert.equal(fragment.id, compiled.entry.id)
    assert.deepEqual(fragment.reads, compiled.entry.effects.reads)
  }
})

test('a route with params refuses a key rather than resolving one against nothing', async () => {
  const built = await app()
  const parameterised = built.routes.find((route) => route.pattern.includes(':'))
  assert.ok(parameterised, 'the demo has no parameterised route to ask about')

  const without = await whyPage(built, parameterised.pattern, new URLSearchParams(), new Headers(), {
    store: built.store,
    session: cookieSession({ cookie: built.config.session.cookie }),
    flags: staticFlags({ axes: built.config.flags }),
    executors: built.config.executors,
  })
  assert.ok(without.missing.length, 'a pattern with a param wants one')
  assert.deepEqual(without.resolved, {}, 'a key was resolved for a page nobody could request')
  // The plan itself is still answerable without a request: the DAG and the critical path are
  // structural, and only the keys need to know who is asking.
  assert.match(without.report.text, /fragment DAG/)
})

test('a key names the read that put it in the class it is in', async () => {
  const built = await app()
  const private_ = routeReport(built).find((route) =>
    route.slots.some((slot) => slot.facts?.effects.reads.includes('identity')),
  )
  assert.ok(private_, 'the demo has no private fragment to ask about')

  const server = await serving({ devtools: true })
  try {
    const url = new URL('/_weft/devtools/why', server.url)
    url.searchParams.set('route', private_.pattern)
    const html = await (await fetch(url)).text()
    assert.match(html, /private/, 'a page whose fragment reads identity did not say private')
    assert.match(html, /identity/)
  } finally {
    await server.close()
  }
})

test('the byte report counts bytes that exist and claims nothing for the ones it cannot measure', async () => {
  const built = await app()
  const report = await byteReport(built)
  assert.equal(report.assets.length, built.assets.files.size)
  for (const asset of report.assets) {
    const served = built.assets.files.get(asset.href)
    assert.ok(served)
    const measured = typeof served.body === 'string' ? Buffer.byteLength(served.body) : served.body.byteLength
    assert.equal(asset.bytes, measured, `${asset.href} reported a length it does not have`)
  }
  assert.equal(
    report.totalBytes,
    report.assets.reduce((sum, asset) => sum + asset.bytes, 0),
  )
  // Dev serves stable names, so nothing in the table may claim to be cacheable.
  assert.equal(report.revved, false)
  assert.equal(
    report.assets.some((asset) => asset.immutable),
    false,
  )
  // A module tree is transformed on the way out, so it is listed and not weighed.
  assert.ok(report.trees.length)
  for (const tree of report.trees) assert.ok(tree.files > 0, `${tree.prefix} mounts nothing`)
})
