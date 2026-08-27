import assert from 'node:assert/strict'
import { readFile, readdir, rm } from 'node:fs/promises'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { build } from '../src/build.ts'
import { loadConfig } from '../src/config.ts'
import { createApp } from '../src/serve.ts'
import { moduleFiles } from '../src/assets.ts'

/**
 * The claim this file exists to keep true: the build directory can be handed to a CDN as it is.
 *
 * It was not. `assets/manifest.json` listed `/_weft/m` URLs and nothing wrote the files behind
 * them, because a module tree is a mounted directory the server reads when a request arrives.
 * Every deployment that served the build itself hid it, and the first to hand the directory to
 * anything else got a site with every page, every stylesheet, and no JavaScript. Nothing about
 * that failure is visible in a build that succeeds, so it is asserted here instead.
 */
const ROOT = fileURLToPath(new URL('../../../demo/', import.meta.url))
const OUT = '.weft-complete'

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

/**
 * Comments removed, because the served source carries doc comments and several of them name the
 * package they document. A quoted occurrence in code is a specifier; the same words in a comment
 * are not.
 */
const code = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

test('every URL the manifest names is a file in the build', async () => {
  const out = await built()
  const manifest = JSON.parse(await readFile(join(out, 'assets', 'manifest.json'), 'utf8')) as Record<
    string,
    string
  >
  const hrefs = [...new Set(Object.values(manifest))]
  assert.ok(
    hrefs.some((href) => href.startsWith('/_weft/m/')),
    'the manifest names no module URL, so this asserts nothing',
  )
  for (const href of hrefs) {
    const file = join(out, 'assets', href.replace(/^\//, ''))
    await assert.doesNotReject(readFile(file), `${href} is in the manifest and not in the build`)
  }
})

test('every module the deployment would answer for is a file in the build', async () => {
  const out = await built()
  const app = await createApp(ROOT, { mode: 'build', outDir: OUT })
  const expected = await moduleFiles(app.assets)
  assert.ok(expected.size > 0, 'no modules were mounted, so this asserts nothing')
  for (const href of expected.keys()) {
    const file = join(out, 'assets', href.replace(/^\//, ''))
    await assert.doesNotReject(readFile(file), `${href} is servable and not in the build`)
  }
})

/**
 * No served module may name a workspace package.
 *
 * `browserModule` rewrites `@weftjs/client` and `@weftjs/warp` to the URLs they are mounted at,
 * because a browser cannot resolve a package name. The rewrite holds those two names as literals
 * inside regular expressions, so renaming a package silently disarms it — which is what happened
 * when the scope moved from `@weft` to `@weftjs`. Every one of 943 tests still passed, the build
 * still succeeded, and the first page load in a browser would have failed on an unresolvable
 * import.
 *
 * The check is a quoted-string search rather than an import parse, for two reasons. The boot module
 * is served as type-stripped source, where the import is spread over twenty lines and no
 * line-anchored pattern sees the `from` clause — the first version of this test missed the very bug
 * it was written for on exactly that. And the names come from the workspace rather than from a list
 * here, so the next rename is caught without anybody remembering to update this file.
 */
test('no module the deployment serves names a workspace package', async () => {
  const out = await built()
  const app = await createApp(ROOT, { mode: 'build', outDir: OUT })
  const served = await moduleFiles(app.assets)
  assert.ok(served.size > 0, 'no modules were mounted, so this asserts nothing')

  const packages = fileURLToPath(new URL('../../', import.meta.url))
  const names: string[] = []
  for (const entry of await readdir(packages)) {
    try {
      names.push(JSON.parse(await readFile(join(packages, entry, 'package.json'), 'utf8')).name)
    } catch {
      // Not a package, so not a name a served module could be asking a browser to resolve.
    }
  }
  assert.ok(names.length > 5, `only ${names.length} workspace packages found: the scan lost something`)

  const offenders: string[] = []
  for (const href of served.keys()) {
    const source = code(await readFile(join(out, 'assets', href.replace(/^\//, '')), 'utf8'))
    for (const name of names) {
      if (source.includes(`'${name}'`) || source.includes(`"${name}"`)) offenders.push(`${href} → ${name}`)
    }
  }
  assert.deepEqual(offenders.sort(), [], 'a browser cannot resolve these, so the page fails on load')
})

/**
 * Every served module URL ends in `.js`.
 *
 * A static host reads the extension and nothing else. `.ts` is `video/mp2t` to all of them, which
 * fails strict MIME checking, so the browser refuses the module — and an application's own
 * `app/client.ts` is always source, so it was served at a `.ts` URL on every deployment that serves
 * files rather than proxying to weft. On this project's documentation site that silently disabled the
 * theme toggle, the search panel, the tab strips and every intent button at once.
 *
 * Asserted on the build output, because that is the directory a host is handed.
 */
test('every module URL in the build ends in .js, whatever the source extension is', async () => {
  const out = await built()
  const app = await createApp(ROOT, { mode: 'build', outDir: OUT })
  const served = [...(await moduleFiles(app.assets)).keys()]
  assert.ok(served.length > 0, 'no modules were mounted, so this asserts nothing')

  assert.deepEqual(
    served.filter((href) => !href.endsWith('.js')),
    [],
    'a host that infers the type from the extension will not serve these as JavaScript',
  )
  assert.ok(app.assets.boot.endsWith('.js'), `the boot URL is ${app.assets.boot}`)
  if (app.assets.app) assert.ok(app.assets.app.endsWith('.js'), `the app client URL is ${app.assets.app}`)

  // And the files are actually there under those names, so the rename is not just cosmetic.
  for (const href of served) {
    await assert.doesNotReject(
      readFile(join(out, 'assets', href.replace(/^\//, ''))),
      `${href} is the URL a document names and there is no file behind it`,
    )
  }

  // Nothing inside them may point at a `.ts` neighbour either.
  const offenders: string[] = []
  for (const href of served) {
    const source = code(await readFile(join(out, 'assets', href.replace(/^\//, '')), 'utf8'))
    for (const match of source.matchAll(/(['"])((?:\.{1,2}\/|\/)[^'"]*\.ts)\1/g)) {
      offenders.push(`${href} imports ${match[2]}`)
    }
  }
  assert.deepEqual(offenders.sort(), [], 'these resolve to a URL the host will type as video/mp2t')
})

test('the boot module carries the prelude, so a CDN copy boots the same as a served one', async () => {
  const out = await built()
  const app = await createApp(ROOT, { mode: 'build', outDir: OUT })
  const boot = await readFile(join(out, 'assets', app.assets.boot.replace(/^\//, '')), 'utf8')
  // The two the client cannot derive. Without them a statically served boot has no intent table
  // and no channel, and fails in the browser rather than in the build.
  assert.match(boot, /window\.__weftIntents = /)
  assert.match(boot, /window\.__weftChannel = /)
})
