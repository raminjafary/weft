import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { fail, run } from './shell.mjs'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')

export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

/** Written back with a trailing newline, because that is what Prettier leaves and the diff should be one line. */
export const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)

/**
 * Every package in `packages/`, with the workspace dependencies each one declares.
 *
 * Only `packages/*` is scanned. `demo/` and `benchmarks/*` are workspace members too, but they are
 * applications with a version of 0.0.0 that nothing installs — a release has no opinion about them.
 */
export function loadWorkspace() {
  const packages = new Map()
  for (const entry of readdirSync(join(ROOT, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const relativeDirectory = `packages/${entry.name}`
    const manifestPath = join(ROOT, relativeDirectory, 'package.json')
    let manifest
    try {
      manifest = readJson(manifestPath)
    } catch {
      continue
    }
    packages.set(manifest.name, {
      name: manifest.name,
      directory: entry.name,
      relativeDirectory,
      manifestPath,
      manifest,
      version: manifest.version,
      isPrivate: manifest.private === true,
      dependencies: workspaceDependencies(manifest),
    })
  }
  if (!packages.size) fail('no packages found under packages/')
  return packages
}

/** The `workspace:` deps of a manifest, in every field where one can appear. */
function workspaceDependencies(manifest) {
  const names = new Set()
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies']) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (typeof range === 'string' && range.startsWith('workspace:')) names.add(name)
    }
  }
  return names
}

/**
 * The published packages, in an order where a package always follows what it depends on.
 *
 * Publishing in this order means a consumer resolving `weft` can always resolve the `@weftjs/*`
 * versions its manifest pins, even mid-release. `devDependencies` are excluded from the edges —
 * they form cycles here (`@weftjs/kernel` dev-depends on `@weftjs/adapters`, which depends on the
 * kernel) and they are not part of what an installer has to resolve.
 */
export function publishOrder(packages) {
  const runtimeEdges = new Map()
  for (const pkg of packages.values()) {
    if (pkg.isPrivate) continue
    const edges = new Set()
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [name, range] of Object.entries(pkg.manifest[field] ?? {})) {
        if (
          typeof range === 'string' &&
          range.startsWith('workspace:') &&
          packages.get(name)?.isPrivate === false
        ) {
          edges.add(name)
        }
      }
    }
    runtimeEdges.set(pkg.name, edges)
  }

  const ordered = []
  const state = new Map()
  const visit = (name, trail) => {
    if (state.get(name) === 'done') return
    if (state.get(name) === 'visiting')
      fail(`dependency cycle between published packages: ${[...trail, name].join(' → ')}`)
    state.set(name, 'visiting')
    for (const edge of runtimeEdges.get(name) ?? []) visit(edge, [...trail, name])
    state.set(name, 'done')
    ordered.push(name)
  }
  for (const name of [...runtimeEdges.keys()].sort()) visit(name, [])
  return ordered
}

/** Everything that would have to be republished if `name` were published, transitively. */
export function dependentsOf(packages, name) {
  const found = new Set()
  const walk = (target) => {
    for (const pkg of packages.values()) {
      if (found.has(pkg.name) || !pkg.dependencies.has(target)) continue
      found.add(pkg.name)
      walk(pkg.name)
    }
  }
  walk(name)
  return found
}

/** A package's manifest as it stood at a git ref, or undefined if it did not exist there. */
export function manifestAt(ref, relativeDirectory) {
  const result = run('git', ['show', `${ref}:${relativeDirectory}/package.json`], { allowFailure: true })
  if (!result.ok) return undefined
  try {
    return JSON.parse(result.stdout)
  } catch {
    return undefined
  }
}

/**
 * A package's commit scope.
 *
 * It is the directory name everywhere but `create-weft`, whose scope is `create` — the commitlint
 * scope list is written for typing, not for matching directories.
 */
export const scopeOf = (pkg) => (pkg.directory === 'create-weft' ? 'create' : pkg.directory)
