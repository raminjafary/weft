import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TARBALL_ALLOWED, TARBALL_FORBIDDEN, TARBALL_TEMPLATES } from '../config.mjs'
import { run } from './shell.mjs'
import { ROOT } from './workspace.mjs'

/**
 * Pack a package for real and check what came out.
 *
 * `files` is the only thing standing between the registry and everything in the directory, and it
 * is silently wrong in one direction: an entry that matches nothing is not an error, so a rename can
 * drop `dist` out of the tarball and the only symptom is `Cannot find module` for whoever installs.
 * Packing and listing catches that, and the export checks below catch it precisely.
 */
export function auditPack(pkg) {
  const destination = mkdtempSync(join(tmpdir(), 'weft-pack-'))
  try {
    run('pnpm', ['pack', '--pack-destination', destination], { cwd: join(ROOT, pkg.relativeDirectory) })
    const tarballs = readdirSync(destination).filter((name) => name.endsWith('.tgz'))
    if (tarballs.length !== 1)
      return { problems: [`pnpm pack produced ${tarballs.length} tarballs`], entries: [], bytes: 0 }
    const tarball = join(destination, tarballs[0])

    const entries = run('tar', ['-tzf', tarball])
      .output.split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.endsWith('/'))
    const bytes = Number(run('wc', ['-c', tarball]).output.trim().split(/\s+/)[0])
    const packed = JSON.parse(run('tar', ['-xOzf', tarball, 'package/package.json']).output)

    return { problems: check(pkg, entries, packed), entries, bytes, packed }
  } finally {
    rmSync(destination, { recursive: true, force: true })
  }
}

function check(pkg, entries, packed) {
  const problems = []

  for (const entry of entries) {
    const inTemplate = entry.startsWith(TARBALL_TEMPLATES)
    const forbidden = TARBALL_FORBIDDEN.find(
      (rule) => (rule.everywhere || !inTemplate) && rule.pattern.test(entry),
    )
    if (forbidden) {
      problems.push(`${entry} — ${forbidden.why}`)
      continue
    }
    if (!TARBALL_ALLOWED.some((pattern) => pattern.test(entry))) {
      problems.push(`${entry} — matches nothing this repository intends to publish`)
    }
  }

  // A `workspace:` range that survived packing would be unresolvable for anybody but this repo.
  // Only the fields an installer resolves are checked: `devDependencies` are published as written
  // and nobody downstream ever reads them.
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, range] of Object.entries(packed[field] ?? {})) {
      if (typeof range === 'string' && range.startsWith('workspace:')) {
        problems.push(`${field}.${name} is still "${range}" in the packed manifest`)
      }
    }
  }

  const inTarball = new Set(entries)
  const requireEntry = (path, why) => {
    if (!inTarball.has(`package/${path}`))
      problems.push(`${why} points at ${path}, which is not in the tarball`)
  }

  for (const target of exportTargets(packed.exports)) requireEntry(target, `exports`)
  for (const [command, target] of Object.entries(packed.bin ?? {}))
    requireEntry(strip(target), `bin.${command}`)
  if (packed.main) requireEntry(strip(packed.main), 'main')
  if (packed.types) requireEntry(strip(packed.types), 'types')
  requireEntry('README.md', 'the registry page')
  requireEntry('CHANGELOG.md', 'the changelog')
  requireEntry('LICENSE', 'the licence')

  if (!packed.description) problems.push('no description; the registry listing would be blank')
  if (!packed.repository) problems.push('no repository field')
  if (!packed.license) problems.push('no license field')

  return problems
}

const strip = (target) => target.replace(/^\.\//, '')

function exportTargets(exports) {
  const targets = []
  const walk = (value) => {
    if (typeof value === 'string') {
      if (value.startsWith('./')) targets.push(strip(value))
      return
    }
    if (value && typeof value === 'object') for (const nested of Object.values(value)) walk(nested)
  }
  walk(exports)
  return targets
}

export const humanBytes = (bytes) =>
  bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
