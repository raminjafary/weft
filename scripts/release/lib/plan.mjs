import { LEVELS } from '../config.mjs'
import { dependentsOf } from './workspace.mjs'
import { fail } from './shell.mjs'

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

export function parseVersion(version) {
  const match = SEMVER.exec(version)
  if (!match) fail(`not a version this tooling can bump: ${version}`)
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] }
}

/**
 * Apply a bump level.
 *
 * Below 1.0.0 a breaking change is a minor bump, which is what semver says the leading zero is for:
 * anything may change and the minor is the compatibility signal. Promoting to 1.0.0 is a decision,
 * not something a commit footer should be able to make on its own.
 */
export function bump(version, level) {
  const { major, minor, patch } = parseVersion(version)
  if (major === 0) {
    if (level === 'major' || level === 'minor') return `0.${minor + 1}.0`
    return `0.${minor}.${patch + 1}`
  }
  if (level === 'major') return `${major + 1}.0.0`
  if (level === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

const highest = (a, b) => (LEVELS.indexOf(b) > LEVELS.indexOf(a ?? 'patch') ? b : (a ?? 'patch'))

/** The level a single commit asks for. Every type earns at least a patch: a docs commit changes the doc comments in a shipped `.d.ts`. */
const levelOf = (commit) => (commit.breaking ? 'major' : commit.type === 'feat' ? 'minor' : 'patch')

/**
 * What to release, from the commits in a range.
 *
 * Two things happen here that a single-package tool cannot do. A commit's scopes are resolved to
 * packages, so `feat(ir,kernel,client)` bumps three. And every dependent of a bumped package is
 * bumped too, at least a patch — because pnpm rewrites `workspace:*` to the exact local version at
 * pack time, so a dependent left behind would either fail to publish over its own existing version
 * or ship a manifest pinning a dependency that did not exist when it was tested.
 */
export function buildPlan({ packages, commits, firstRelease }) {
  const directLevels = new Map()
  const commitsByPackage = new Map()
  const byDirectory = new Map([...packages.values()].map((pkg) => [pkg.relativeDirectory, pkg]))

  let rootLevel = undefined
  for (const commit of commits) {
    // A commit with no scope, or a repository-level one, still moves the release train.
    rootLevel = highest(rootLevel, levelOf(commit))
    for (const directory of commit.packages) {
      const pkg = byDirectory.get(directory)
      if (!pkg) continue
      directLevels.set(pkg.name, highest(directLevels.get(pkg.name), levelOf(commit)))
      if (!commitsByPackage.has(pkg.name)) commitsByPackage.set(pkg.name, [])
      commitsByPackage.get(pkg.name).push(commit)
    }
  }

  const levels = new Map(directLevels)
  const propagatedFrom = new Map()
  for (const name of directLevels.keys()) {
    for (const dependent of dependentsOf(packages, name)) {
      if (!levels.has(dependent)) levels.set(dependent, 'patch')
      if (!propagatedFrom.has(dependent)) propagatedFrom.set(dependent, new Set())
      if (!directLevels.has(dependent)) propagatedFrom.get(dependent).add(name)
    }
  }

  const releases = []
  for (const pkg of [...packages.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const level = levels.get(pkg.name)
    if (!firstRelease && !level) continue
    releases.push({
      name: pkg.name,
      package: pkg,
      level: level ?? 'minor',
      from: pkg.version,
      // The first release publishes the versions already written in the manifests. They say 0.1.0,
      // which is where this project starts, and inventing 0.2.0 for it would be a lie about history.
      to: firstRelease ? pkg.version : bump(pkg.version, level),
      commits: commitsByPackage.get(pkg.name) ?? [],
      propagatedFrom: [...(propagatedFrom.get(pkg.name) ?? [])].sort(),
      direct: directLevels.has(pkg.name),
    })
  }

  return {
    firstRelease,
    rootLevel: rootLevel ?? 'patch',
    releases,
    published: releases.filter((release) => !release.package.isPrivate),
  }
}
