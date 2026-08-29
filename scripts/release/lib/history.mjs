import { commitsIn, releaseTags, tagDate } from './commits.mjs'
import { manifestAt } from './workspace.mjs'

/** Every release this repository has cut, plus the one being cut now. No per-package tags: a version is read out of the tagged tree. */
export function releaseBoundaries(pending) {
  const tags = releaseTags()
  const boundaries = tags.map((tag, index) => ({
    tag,
    version: tag.slice(1),
    date: tagDate(tag),
    previousTag: index === 0 ? undefined : tags[index - 1],
    range: index === 0 ? tag : `${tags[index - 1]}..${tag}`,
  }))
  if (pending) {
    const previousTag = tags.at(-1)
    boundaries.push({
      tag: undefined,
      version: pending.version,
      date: pending.date,
      previousTag,
      range: previousTag ? `${previousTag}..HEAD` : undefined,
      // "Unreleased" rather than a number nobody has released — root and package files must agree.
      unversioned: !/^\d+\.\d+\.\d+/.test(pending.version),
    })
  }
  return boundaries
}

/** The root changelog's entries, newest first. Read from git each time, so regeneration is also the repair tool. */
export function rootEntries(boundaries) {
  return boundaries.map((boundary) => ({ ...boundary, commits: commitsIn(boundary.range) })).toReversed()
}

/** One package's changelog entries, newest first. A version change with no scoped commit is a propagated bump, noted by diffing dependency versions. */
export function packageEntries(pkg, boundaries, versionsAt) {
  const entries = []
  for (const [index, boundary] of boundaries.entries()) {
    const version = versionsAt[index].get(pkg.name)
    if (!version) continue
    const previous = index === 0 ? undefined : versionsAt[index - 1].get(pkg.name)
    if (previous === version) continue

    const commits = commitsIn(boundary.range).filter((commit) =>
      commit.packages.includes(pkg.relativeDirectory),
    )
    const dependencyNotes = commits.length
      ? []
      : [...pkg.dependencies]
          .filter((name) => {
            const before = index === 0 ? undefined : versionsAt[index - 1].get(name)
            const after = versionsAt[index].get(name)
            return before && after && before !== after
          })
          .sort()
          .map((name) => ({ note: `bumped for \`${name}@${versionsAt[index].get(name)}\`` }))

    entries.push({
      ...boundary,
      version: boundary.unversioned ? boundary.version : version,
      commits,
      dependencyNotes,
    })
  }
  return entries.toReversed()
}

/** Every package's version at each boundary: read from the tagged tree, or from the plan for the pending release. */
export function versionsAtBoundaries(packages, boundaries, plan) {
  const planned = new Map((plan?.releases ?? []).map((release) => [release.name, release.to]))
  return boundaries.map((boundary) => {
    const versions = new Map()
    for (const pkg of packages.values()) {
      if (!boundary.tag) {
        versions.set(pkg.name, planned.get(pkg.name) ?? pkg.version)
        continue
      }
      const manifest = manifestAt(boundary.tag, pkg.relativeDirectory)
      if (manifest?.version) versions.set(pkg.name, manifest.version)
    }
    return versions
  })
}
