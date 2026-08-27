import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
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

test('the boot module carries the prelude, so a CDN copy boots the same as a served one', async () => {
  const out = await built()
  const app = await createApp(ROOT, { mode: 'build', outDir: OUT })
  const boot = await readFile(join(out, 'assets', app.assets.boot.replace(/^\//, '')), 'utf8')
  // The two the client cannot derive. Without them a statically served boot has no intent table
  // and no channel, and fails in the browser rather than in the build.
  assert.match(boot, /window\.__weftIntents = /)
  assert.match(boot, /window\.__weftChannel = /)
})
