import { spawnSync } from 'node:child_process'
import { copyFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Built in dependency order, because a package's exports map points at its declarations and a
 * dependent cannot typecheck against a `.d.ts` that does not exist yet. The order is the DAG in
 * `pnpm-workspace.yaml`, stated once here rather than inferred on every run.
 */
const ORDER = [
  'ir',
  'warp',
  'client',
  'compiler',
  'kernel',
  'plan',
  'adapters',
  // `weft` before `bench`: the benchmark measures the framework's own build and start paths, so
  // it typechecks against `weft`'s declarations and cannot be built before they exist.
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
  /**
   * `dist` is emptied first, because `tsc` writes and never prunes.
   *
   * A file it emitted once stays until something deletes it, and `files: ["dist"]` publishes the
   * whole directory — so an artifact that stopped being generated goes on shipping. That is not
   * hypothetical: turning `sourceMap` and `declarationMap` off left 378 stale `.map` files behind,
   * every one of them a map pointing at a `src` the tarball does not carry, and the pack audit found
   * them rather than a reader of this script. Rebuilding from empty costs about a second.
   */
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

/**
 * Nothing may be emitted beside a source file.
 *
 * `rootDir` already refuses a program that reaches outside `src`, but it refuses it *after*
 * writing what it had — so a build that failed once can leave a `.js` next to a `.ts` that then
 * shadows it for every tool that resolves extensions. Checking is cheap and the failure is silent
 * otherwise.
 */
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

/**
 * The licence, beside every package that is published.
 *
 * npm shows the `license` field but a tarball with no LICENSE in it makes the terms something you
 * have to go and look up. Copying beats twelve identical committed files: there is one licence in
 * this repository, and `packages/*\/LICENSE` is gitignored so it cannot drift from it.
 */
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
