import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { build } from '../src/build.ts'
import { loadConfig } from '../src/config.ts'
import { uploadBuild } from '../src/upload.ts'

const ROOT = fileURLToPath(new URL('../../../demo/', import.meta.url))

/**
 * Its own output directory, because two processes building one application race.
 *
 * `demo/test/static.test.ts` builds the same demo, and a build empties its own directory before it
 * writes — so a shared `.weft` means one test file deleting the other's artefacts halfway through.
 * The upload has no opinion about which directory it is given, which is what makes this possible.
 */
const OUT = '.weft-upload'

let dir: string | null = null
async function built(): Promise<string> {
  if (!dir) {
    await build(ROOT, { outDir: OUT })
    dir = join(ROOT, (await loadConfig(ROOT, { outDir: OUT })).outDir)
  }
  return dir
}

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

interface Received {
  method: string
  path: string
  headers: Record<string, string>
  bytes: number
}

/**
 * A real object store, for the purposes this needs one for: it accepts `PUT` at a path, answers
 * `HEAD` for what it has, and records what arrived. Nothing here mocks the upload — the code under
 * test makes real HTTP requests, which is the only way to find out whether it sets the headers it
 * claims to.
 */
async function store(): Promise<{
  url: string
  received: Received[]
  hold(path: string): void
  close(): Promise<void>
}> {
  const received: Received[] = []
  const held = new Set<string>()
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? '/'
    if (req.method === 'HEAD') {
      received.push({ method: 'HEAD', path, headers: {}, bytes: 0 })
      res.writeHead(held.has(path) ? 200 : 404).end()
      return
    }
    let bytes = 0
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength
    })
    req.on('end', () => {
      received.push({
        method: req.method ?? '?',
        path,
        headers: Object.fromEntries(
          Object.entries(req.headers).filter(([, v]) => typeof v === 'string'),
        ) as Record<string, string>,
        bytes,
      })
      held.add(path)
      res.writeHead(200).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address === 'string' || !address) throw new Error('no address')
  return {
    url: `http://127.0.0.1:${address.port}`,
    received,
    hold: (path) => held.add(path),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

test('the build directory goes up over HTTP, with the headers each object is served with', async () => {
  const dir_ = await built()
  const target = await store()
  try {
    const report = await uploadBuild({ dir: dir_, to: target.url, headers: { authorization: 'Bearer t' } })
    assert.equal(report.failed, 0, JSON.stringify(report.objects.filter((o) => o.status === 'failed')))
    assert.ok(report.uploaded > 5, `${report.uploaded} objects`)
    assert.ok(report.sent > 0)

    const puts = target.received.filter((r) => r.method === 'PUT')
    assert.equal(puts.length, report.uploaded)
    for (const put of puts)
      assert.equal(put.headers.authorization, 'Bearer t', 'auth is a header, not an SDK')

    // An L0 document goes up at the URL it answers, with the cache-control the build proved it
    // may carry — not the `no-store` a kernel with no declared policy would have emitted.
    const document = puts.find((put) => put.path === '/app/article')
    assert.ok(document, 'the L0 documents are part of the upload')
    assert.equal(document.headers['cache-control'], 'public, max-age=0, must-revalidate')
    assert.match(document.headers['content-type'] ?? '', /text\/html/)

    // A parameterised route is one object per URL, which is what makes it a file at all.
    assert.ok(puts.some((put) => put.path === '/app/ordinary/pantry'))
    assert.ok(puts.some((put) => put.path === '/app/ordinary/household'))

    // An asset URL names its own contents, so it may be held for a year.
    const asset = puts.find((put) => put.path.startsWith('/_weft/'))
    assert.ok(asset, 'the revved assets are part of the upload')
    assert.match(asset.headers['cache-control'] ?? '', /immutable/)
  } finally {
    await target.close()
  }
})

test('an immutable object already there is skipped, and a document never is', async () => {
  const dir_ = await built()
  const target = await store()
  try {
    const first = await uploadBuild({ dir: dir_, to: target.url })
    const second = await uploadBuild({ dir: dir_, to: target.url })

    assert.equal(second.failed, 0)
    // Everything whose URL names its contents is already correct, so nothing is re-sent.
    const resentAssets = second.objects.filter(
      (object) => object.status === 'uploaded' && object.href.startsWith('/_weft/'),
    )
    assert.deepEqual(resentAssets, [])
    // The documents are re-sent, because an L0 path is a stable URL whose contents change with
    // every build — the exact inverse of an immutable asset.
    const documents = second.objects.filter(
      (object) => object.status === 'uploaded' && !object.href.startsWith('/_weft/'),
    )
    assert.ok(documents.length > 0, 'a document is always written')
    assert.ok(second.sent < first.sent, `${second.sent} B against the first upload's ${first.sent} B`)
  } finally {
    await target.close()
  }
})

test('a dry run says what would happen and sends nothing at all', async () => {
  const dir_ = await built()
  const target = await store()
  try {
    const report = await uploadBuild({ dir: dir_, to: target.url, dryRun: true })
    assert.equal(report.uploaded, 0)
    assert.equal(report.sent, 0)
    assert.ok(report.skipped > 5)
    assert.deepEqual(target.received, [], 'not even a HEAD')
  } finally {
    await target.close()
  }
})

test('a store that refuses one object reports that object and finishes the rest', async () => {
  const dir_ = await built()
  const target = await store()
  try {
    let refused = 0
    const report = await uploadBuild({
      dir: dir_,
      to: target.url,
      concurrency: 2,
      fetch: async (input, init) => {
        const url = String(input)
        if (init?.method === 'PUT' && url.endsWith('/app/article') && refused++ === 0) {
          return new Response(null, { status: 403 })
        }
        return fetch(input as string, init)
      },
    })
    assert.equal(report.failed, 1)
    const failure = report.objects.find((object) => object.status === 'failed')
    assert.equal(failure?.href, '/app/article')
    assert.match(failure?.detail ?? '', /403/)
    assert.ok(report.uploaded > 5, 'and everything else still went up')
  } finally {
    await target.close()
  }
})
