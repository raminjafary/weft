import { join } from 'node:path'

import { run, runVisible } from './shell.mjs'
import { ROOT } from './workspace.mjs'

/** The npm account this release would publish as, or undefined if nobody is logged in. */
export function whoami() {
  const result = run('npm', ['whoami'], { allowFailure: true })
  return result.ok ? result.output.trim() : undefined
}

/** Whether a version is already on the registry, so a re-run after a partial release is a no-op rather than an error. */
export function isPublished(name, version) {
  const result = run('npm', ['view', `${name}@${version}`, 'version', '--json'], { allowFailure: true })
  if (!result.ok) return false
  // Compared, not searched for: a substring test would read 0.1.10 as 0.1.0 and silently skip the
  // publish of a version that is not there.
  try {
    return JSON.parse(result.output) === version
  } catch {
    return false
  }
}

/** Every version of a package the registry currently serves. */
export function publishedVersions(name) {
  const result = run('npm', ['view', name, 'versions', '--json'], { allowFailure: true })
  if (!result.ok) return []
  try {
    const value = JSON.parse(result.output)
    return Array.isArray(value) ? value : [value]
  } catch {
    return []
  }
}

/**
 * Whether this account could publish this name at all.
 *
 * Worth its own check because the failure it catches is the worst one available: a release that has
 * already bumped, committed, tagged and pushed, and then discovers halfway through publishing that
 * somebody else owns the name. The registry answers in two different ways depending on whether the
 * name exists, so both are asked.
 */
export function claim(name, user) {
  if (name.startsWith('@')) {
    const scope = name.slice(1).split('/')[0]
    const scopeResult = run('npm', ['access', 'list', 'packages', scope], { allowFailure: true })
    if (/scope not found/i.test(scopeResult.output)) {
      return {
        ok: false,
        why: `the @${scope} scope does not exist. Create the npm organisation, or rename the package.`,
      }
    }
  }

  const existing = run('npm', ['view', name, 'version'], { allowFailure: true })
  if (!existing.ok) return { ok: true, why: 'the name is free' }

  const owners = run('npm', ['owner', 'ls', name], { allowFailure: true })
  const maintainers = owners.output
    .split('\n')
    .map((line) => line.split(' ')[0].trim())
    .filter(Boolean)
  if (user && maintainers.includes(user)) {
    return { ok: true, why: `already yours, at ${existing.output.trim()}` }
  }
  return {
    ok: false,
    why: `npm already serves ${name}@${existing.output.trim()}, owned by ${maintainers.join(', ') || 'somebody else'}. Rename, or have it transferred.`,
  }
}

/**
 * Publish one package.
 *
 * `--no-git-checks` because the release commit and tag are already made by the time this runs, and
 * pnpm's own check would otherwise refuse on the tag it is being asked to publish. The tag it
 * refuses on is the one we created; the checks that matter — clean tree, right branch, in sync with
 * the remote — ran in the preflight, before anything was written.
 */
export function publish(pkg, { dryRun }) {
  return runVisible(
    'pnpm',
    ['publish', '--no-git-checks', '--access', 'public', ...(dryRun ? ['--dry-run'] : [])],
    { cwd: join(ROOT, pkg.relativeDirectory), allowFailure: true },
  )
}

/**
 * Remove a version from the registry.
 *
 * npm allows this for 72 hours after publishing, and only if nothing depends on it. It does not
 * free the version number: npm refuses to ever publish `name@version` again once that pair has
 * existed, so the next release has to be a new number. `release:undo` says so before it runs.
 */
export function unpublish(name, version, { dryRun }) {
  if (dryRun) return { ok: true, output: `would run: npm unpublish ${name}@${version}` }
  return run('npm', ['unpublish', `${name}@${version}`], { allowFailure: true })
}

/** The fallback when the 72-hour window has closed: the version stays, and installing it warns. */
export function deprecate(name, version, message, { dryRun }) {
  if (dryRun) return { ok: true, output: `would run: npm deprecate ${name}@${version} "${message}"` }
  return run('npm', ['deprecate', `${name}@${version}`, message], { allowFailure: true })
}
