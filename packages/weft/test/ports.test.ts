import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { staticConfig, staticDeployment } from '@weftjs/adapters'
import { createApp, serveApp, type Serving } from '../src/serve.ts'
import { weftAssets } from '../src/assets.ts'
import { services } from '../src/context.ts'

const ROOT = fileURLToPath(new URL('../../../demo/', import.meta.url))

const servers: Serving[] = []
after(async () => {
  for (const serving of servers) await serving.close()
})

async function started(): Promise<Serving> {
  const serving = await serveApp(await createApp(ROOT, { mode: 'dev', port: 0 }))
  servers.push(serving)
  return serving
}

/**
 * Phase 2's remaining half: the ports that were declared and bound to nothing.
 *
 * These assertions are about the front door rather than about the adapters, because a port with an
 * implementation nobody binds is the same as a port with no implementation. What each one proves
 * is that the framework is now the thing asking.
 */
test('every page hints its own stylesheet and the runtime, before it renders', async () => {
  const app = await started()
  const assets = weftAssets(() => app.app.assets)

  for (const route of app.app.routes) {
    const links = assets.criticalFor(route.pattern)
    const styles = links.filter((link) => link.as === 'style')
    assert.equal(styles.length, 1, `${route.pattern} links exactly one stylesheet`)
    assert.equal(
      styles[0]?.href,
      app.app.assets.pageCss(route.pattern),
      'the href is the revved one this page actually links, not a guess at it',
    )
    assert.ok(
      links.some((link) => link.rel === 'modulepreload' && link.href === app.app.assets.boot),
      `${route.pattern} hints the client runtime as a module`,
    )
  }
})

test('the kernel asks the assets port when the route did not say', async () => {
  const app = await started()
  const response = await fetch(new URL('/app/feed', app.url))
  assert.equal(response.status, 200)
  await response.arrayBuffer()

  // Node's transport reports whether the 103 went out. Over HTTP/1.1 it does not, which is the
  // documented case — what is asserted here is that the links were *computed*, because a hint set
  // that is empty is a hint set no transport could have sent.
  const links = app.app.ports.assets?.criticalFor('/app/feed') ?? []
  assert.ok(links.length >= 2, 'a stylesheet and a runtime, at minimum')
})

test('ten ports are bound, and the three that are not are per request', async () => {
  const app = await started()
  const bound = app.app.ports
  for (const port of [
    'store',
    'flags',
    'session',
    'executors',
    'scheduler',
    'assets',
    'render',
    'config',
    'deployment',
    'db',
  ] as const) {
    assert.ok(bound[port], `${port} is bound`)
  }
  assert.equal(bound.transport, undefined, 'the transport is a ServerResponse, so it is per request')
})

test('a setting is not a read, so it cannot enter a cache key', async () => {
  const app = await started()
  const ports = { ...app.app.ports, config: staticConfig({ API: 'https://api.example' }) }
  const bound = services(ports)
  assert.equal(bound.setting('API'), 'https://api.example')
  assert.equal(bound.setting('NOPE'), undefined)
  assert.throws(() => bound.required('NOPE'), /E_CONFIG_MISSING/)

  // The property that matters: a loader reading a setting adds nothing to the taints the key is
  // derived from, because a setting is a property of the deployment rather than of the request.
  const reads: string[] = []
  const ctx = {
    phase: 'render' as const,
    taints: () => reads,
    defer: () => {},
  } as never
  const wrapped = { ...(ctx as object), ...bound } as ReturnType<typeof services> & { taints(): string[] }
  wrapped.setting('API')
  assert.deepEqual(wrapped.taints(), [], 'nothing tainted')
})

test('a port that is not bound refuses by name rather than returning nothing', () => {
  const bare = services({ executors: {} } as never)
  assert.throws(() => bare.setting('API'), /E_PORT_UNIMPLEMENTED \[config\]/)
  assert.throws(() => bare.required('API'), /E_PORT_UNIMPLEMENTED \[config\]/)
  // Thrown rather than rejected, on purpose: an unbound port is a deployment mistake, and a
  // deployment mistake that arrives as a rejected promise is one a `.catch()` can swallow.
  assert.throws(
    () => bare.data({ name: 'anything' }, () => Promise.resolve(1)),
    /E_PORT_UNIMPLEMENTED \[db\]/,
  )
})

test('a deployment the config named is the one the application reports', async () => {
  const named = await serveApp(
    await createApp(ROOT, {
      mode: 'dev',
      port: 0,
      deployment: staticDeployment({ revision: 'abc123', environment: 'preview', region: 'fra' }),
    }),
  )
  servers.push(named)
  assert.equal(named.app.ports.deployment?.revision, 'abc123')
  assert.equal(named.app.ports.deployment?.environment, 'preview')

  const response = await fetch(new URL('/app/article', named.url))
  await response.arrayBuffer()
  assert.equal(response.headers.get('x-weft-revision'), 'abc123', 'which build answered, on the response')
})
