import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { addressedByDigest } from '../src/assets.ts'
import { createApp, serveApp, type Serving } from '../src/serve.ts'

/**
 * A URL that names its own contents, asked for when there is nothing behind it.
 *
 * A digest-bearing path is served with a year and `immutable`, and that is sound: the URL changes
 * when the bytes do, so there is no deploy that changes what it means. The corollary had no code.
 * A digest is a promise about what the file contains *if it exists* — not that it exists — and the
 * answer at one of these URLs can go from 404 to 200 without the URL moving. That is what a
 * rollback is: a build that removes a module, then a redeploy of the one that had it.
 *
 * A client that asked during the window in between, and was told to keep the answer for a year, is
 * a client that cannot load the runtime for a year. The deploy most likely to produce it is the one
 * you least want broken.
 *
 * `no-store` rather than `no-cache`, because there is nothing here to revalidate and the whole risk
 * is a copy being kept — and because it is the header most likely to survive a platform's own
 * caching rules, which are written per path and cannot see a status.
 */
const ROOT = fileURLToPath(new URL('../../../demo/', import.meta.url))

const servers: Serving[] = []
after(async () => {
  for (const serving of servers) await serving.close()
})

let started: Promise<Serving> | null = null
function app(): Promise<Serving> {
  started ??= (async () => {
    const serving = await serveApp(await createApp(ROOT, { mode: 'dev', port: 0 }))
    servers.push(serving)
    return serving
  })()
  return started
}

test('a miss under a digest root is not stored by anybody', async () => {
  const serving = await app()
  for (const path of [
    '/_weft/m/deadbeef00/client/boot.js',
    '/_weft/m/deadbeef00/runtime/index.js',
    '/_weft/s/nosuchsheet.css',
    '/_weft/a/nosuchdigest/logo.svg',
  ]) {
    const response = await fetch(`${serving.url.replace(/\/$/, '')}${path}`)
    assert.equal(response.status, 404, path)
    assert.equal(
      response.headers.get('cache-control'),
      'no-store',
      `${path} was answered with a policy a client may keep`,
    )
    assert.match(
      response.headers.get('content-type') ?? '',
      /text\/plain/,
      `${path} answered a stylesheet request with a document`,
    )
  }
})

/**
 * And a page that does not exist is still a page.
 *
 * The rule above is about content-addressed URLs and must not become a rule about 404s. A missing
 * route is a document, with a document's policy and a document's body — a reader who mistypes a
 * path gets the site's own 404 rather than a line of plain text.
 */
test('an ordinary 404 is untouched by it', async () => {
  const serving = await app()
  const response = await fetch(`${serving.url.replace(/\/$/, '')}/no-such-page`)
  assert.equal(response.status, 404)
  assert.match(response.headers.get('content-type') ?? '', /text\/html/)
  assert.notEqual(response.headers.get('cache-control'), 'no-store')
})

test('the roots are the three the build writes, and nothing else', () => {
  for (const path of ['/_weft/a/x', '/_weft/s/x.css', '/_weft/m/abc/x.js']) {
    assert.equal(addressedByDigest(path), true, path)
  }
  for (const path of ['/_weft/channel', '/_weft/i/cart.add', '/_weft/token', '/', '/guide', '/_weft/mine']) {
    assert.equal(addressedByDigest(path), false, path)
  }
})
