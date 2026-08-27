import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildAssets, revAssets, rewriteUrls } from '../src/assets.ts'

/**
 * Two directories, two meanings.
 *
 * `public/` is copied. What is in it is served at the path it is written at, byte for byte, and a
 * URL that does not name its contents cannot be held — `robots.txt` and a verification file have
 * to be at a fixed path, and that is the whole of what the directory is for.
 *
 * `app/assets/` is processed. Nothing in it is served at the path it is written at; every file is
 * published once, under a digest of its own contents, immutable for a year. A page reaches it
 * through `asset()` and a stylesheet reaches it through an ordinary relative `url()`, which is the
 * half that matters — a font is referenced from CSS, so a font is exactly the asset that could not
 * be made immutable before this existed.
 *
 * The distinction is worth testing rather than trusting, because both mistakes are silent. An
 * asset served at its literal path is a year of the wrong file for anyone who cached it; a `url()`
 * left alone is a request for a path that no longer exists.
 */

const WOFF = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 1, 2, 3, 4])

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'weft-assets-'))
  await mkdir(join(root, 'app', 'assets', 'fonts'), { recursive: true })
  await mkdir(join(root, 'public'), { recursive: true })
  await writeFile(join(root, 'app', 'assets', 'fonts', 'inter.woff2'), WOFF)
  await writeFile(join(root, 'app', 'assets', 'logo.svg'), '<svg/>')
  await writeFile(join(root, 'public', 'robots.txt'), 'User-agent: *\n')
  return root
}

test('a file in app/assets is published once, under a digest of its contents', async () => {
  const root = await fixture()
  const revved = await revAssets(join(root, 'app', 'assets'), true)

  const href = revved.byPath.get(join(root, 'app', 'assets', 'fonts', 'inter.woff2'))
  assert.ok(href, 'the font has no URL')
  assert.match(href, /^\/_weft\/p\/[0-9a-f]{10}\/fonts\/inter\.woff2$/)
  assert.equal(revved.files.get(href)?.immutable, true)

  // Not at the path it was written at. That URL does not name its contents, so serving it would
  // be a promise the next build cannot keep.
  assert.equal(revved.files.get('/fonts/inter.woff2'), undefined)
  assert.equal(revved.files.get('/assets/fonts/inter.woff2'), undefined)
})

test('the digest moves with the contents, and only with the contents', async () => {
  const root = await fixture()
  const file = join(root, 'app', 'assets', 'logo.svg')
  const before = (await revAssets(join(root, 'app', 'assets'), true)).byPath.get(file)
  const again = (await revAssets(join(root, 'app', 'assets'), true)).byPath.get(file)
  assert.equal(before, again, 'the same bytes produced two URLs')

  await writeFile(file, '<svg><rect/></svg>')
  const after = (await revAssets(join(root, 'app', 'assets'), true)).byPath.get(file)
  assert.notEqual(before, after, 'the bytes changed and the URL did not')
})

test('a relative url() in a stylesheet becomes the revved href', async () => {
  const root = await fixture()
  const dir = join(root, 'app', 'assets')
  const revved = await revAssets(dir, true)
  const href = revved.byPath.get(join(dir, 'fonts', 'inter.woff2')) as string

  const css = `@font-face { font-family: Inter; src: url('./assets/fonts/inter.woff2') format('woff2') }`
  const out = rewriteUrls(css, join(root, 'app'), revved.byPath)
  assert.ok(out.includes(href), `url() was not rewritten:\n${out}`)
  assert.ok(!out.includes('./assets/fonts/inter.woff2'), 'the written path survived the rewrite')
})

test('every spelling of a relative url() is rewritten, and quoting is preserved', async () => {
  const root = await fixture()
  const dir = join(root, 'app', 'assets')
  const revved = await revAssets(dir, true)
  const logo = revved.byPath.get(join(dir, 'logo.svg')) as string

  for (const written of [`url(./assets/logo.svg)`, `url('./assets/logo.svg')`, `url("./assets/logo.svg")`]) {
    const out = rewriteUrls(`a { background: ${written} }`, join(root, 'app'), revved.byPath)
    assert.ok(out.includes(logo), `${written} was not rewritten`)
  }
})

test('a url() that is not a file in app/assets is left exactly as it was', async () => {
  const root = await fixture()
  const revved = await revAssets(join(root, 'app', 'assets'), true)
  // Absolute, remote, inline, and a fragment reference to something in the same document. None of
  // them name a file this build revved, and rewriting any of them would break it.
  const css = [
    `@import url(https://fonts.example/css);`,
    `a { background: url(data:image/gif;base64,R0lGOD) }`,
    `b { background: url(/robots.txt) }`,
    `c { filter: url(#blur) }`,
  ].join('\n')
  assert.equal(rewriteUrls(css, join(root, 'app'), revved.byPath), css)
})

test('a relative url() that resolves to nothing is refused by name', async () => {
  const root = await fixture()
  const revved = await revAssets(join(root, 'app', 'assets'), true)
  assert.throws(
    () => rewriteUrls(`a { background: url('./assets/missing.svg') }`, join(root, 'app'), revved.byPath),
    /E_NO_ASSET/,
    'a url() pointing at nothing passed through silently',
  )
})

test('public is copied: one URL, the path it was written at, and never immutable', async () => {
  const root = await fixture()
  const table = await buildAssets({
    pageCss: new Map(),
    publicDir: join(root, 'public'),
    assetsDir: join(root, 'app', 'assets'),
    client: { dir: join(root, 'app'), ext: '.ts' },
    runtime: { dir: join(root, 'app'), ext: '.ts' },
    warp: { dir: join(root, 'app'), ext: '.ts' },
    revved: true,
  })

  const copied = table.files.get('/robots.txt')
  assert.ok(copied, 'a file in public/ is not served at the path it was written at')
  assert.equal(copied.immutable, false)

  // No revved twin. Two URLs for one file is two cache entries, and the second one was only ever
  // reachable by asking the framework for a path the author never wrote.
  const twins = [...table.files.keys()].filter((href) => href.endsWith('/robots.txt'))
  assert.deepEqual(twins, ['/robots.txt'])
})

test('asset() answers for app/assets, and refuses a path that is not in it', async () => {
  const root = await fixture()
  const table = await buildAssets({
    pageCss: new Map(),
    publicDir: join(root, 'public'),
    assetsDir: join(root, 'app', 'assets'),
    client: { dir: join(root, 'app'), ext: '.ts' },
    runtime: { dir: join(root, 'app'), ext: '.ts' },
    warp: { dir: join(root, 'app'), ext: '.ts' },
    revved: true,
  })

  assert.match(table.asset('fonts/inter.woff2'), /^\/_weft\/p\/[0-9a-f]{10}\/fonts\/inter\.woff2$/)
  assert.throws(() => table.asset('fonts/nothing.woff2'), /E_NO_ASSET/)
})
