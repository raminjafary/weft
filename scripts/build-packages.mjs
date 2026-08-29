import { spawnSync } from 'node:child_process'
import { copyFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Built in dependency order — a dependent can't typecheck against a `.d.ts` that doesn't exist yet. The DAG, stated once rather than inferred per run. */
const ORDER = [
  'ir',
  'warp',
  'client',
  'compiler',
  'kernel',
  'plan',
  'adapters',
  // `weft` before `bench`: the benchmark typechecks against `weft`'s declarations.
  'weft',
  'bench',
  'create-weft',
]

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const only = process.argv.slice(2)
let failed = 0

for (const name of ORDER) {
  if (only.length && !only.includes(name)) continue
  const cwd = join(root, 'packages', name)
  process.stdout.write(`  ${name} … `)
  // `dist` emptied first: `tsc` writes and never prunes. Turning off sourceMap/declarationMap once
  // left 378 stale `.map` files shipping in tarballs — the pack audit found them, not a reader here.
  rmSync(join(cwd, 'dist'), { recursive: true, force: true })
  const result = spawnSync('pnpm', ['run', 'build'], { cwd, encoding: 'utf8' })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  if (result.status === 0) {
    process.stdout.write('ok\n')
    continue
  }
  failed++
  process.stdout.write('failed\n')
  process.stdout.write(`${output}\n\n`)
  // Stop at the first failure: everything after it would fail against missing declarations and
  // bury the one error that matters.
  break
}

// Nothing may be emitted beside a source file: `rootDir` refuses this, but only *after* writing
// what it had, so a failed build can leave a `.js` shadowing its `.ts` for every resolver.
const stray = []
for (const name of ORDER) {
  const src = join(root, 'packages', name, 'src')
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.(js|d\.ts|map)$/.test(entry.name)) stray.push(path)
    }
  }
  try {
    walk(src)
  } catch {
    // A package with no src is not a package this script built.
  }
}
if (stray.length) {
  process.stdout.write(`\n  emitted beside source, which shadows it:\n`)
  for (const path of stray) process.stdout.write(`    ${path.slice(root.length + 1)}\n`)
  process.exit(1)
}

// The licence, beside every published package. Copied rather than committed per-package, so it can't drift.
const licence = join(root, 'LICENSE')
for (const name of ORDER) {
  const directory = join(root, 'packages', name)
  try {
    if (JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).private === true) continue
    copyFileSync(licence, join(directory, 'LICENSE'))
  } catch {
    // A package this script cannot read is a package it did not build.
  }
}

process.exit(failed ? 1 : 0)
