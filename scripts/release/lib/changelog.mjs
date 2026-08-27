import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { SECTIONS } from '../config.mjs'
import { ROOT } from './workspace.mjs'

const PREAMBLE = [
  '# Changelog',
  '',
  'Every commit in this repository appears here, not only `feat` and `fix`. The sections are',
  'generated from Conventional Commit types by `scripts/release/`, and a package changelog holds',
  'the commits scoped to that package.',
  '',
]

/**
 * The commits that predate `build(repo): enforce conventional commits` carry no type, so nothing
 * can classify them. Saying so once at the top of the entry beats a reader wondering why one
 * section is written in a different voice from the rest.
 */
const FOUNDATIONS_NOTE =
  "The commits below predate this repository's Conventional Commits rule. They are the work the " +
  'convention was adopted in the middle of, kept here because 0.1.0 contains them.'

/**
 * A changelog file, rendered whole.
 *
 * Regenerating the entire file on every release rather than prepending to it is deliberate: the
 * changelog then has one source of truth — the git history — and a changelog that has drifted from
 * it (this one had, with commit links pointing at rewritten shas) is repaired by running the
 * generator rather than by hand.
 */
export function renderChangelog({ entries, repository, scopeless }) {
  const lines = [...PREAMBLE]
  for (const entry of entries) lines.push(...renderEntry(entry, repository, scopeless), '')
  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`
}

function renderEntry(entry, repository, scopeless) {
  const heading = entry.previousTag
    ? `## [${entry.version}](${compareUrl(repository, entry.previousTag, entry.tag ?? 'HEAD')}) (${entry.date})`
    : `## ${entry.version} (${entry.date})`
  const lines = [heading, '']

  if (!entry.commits.length && entry.dependencyNotes?.length === 0) {
    lines.push('No changes recorded for this package in this release.', '')
    return lines
  }

  const buckets = new Map()
  for (const commit of entry.commits) {
    if (!buckets.has(commit.type)) buckets.set(commit.type, [])
    buckets.get(commit.type).push(commit)
  }
  if (entry.dependencyNotes?.length) buckets.set('deps', entry.dependencyNotes)

  for (const section of SECTIONS) {
    const items = buckets.get(section.type)
    if (!items?.length) continue
    lines.push(`### ${section.title}`, '')
    if (section.type === 'foundations') lines.push(FOUNDATIONS_NOTE, '')
    for (const item of items) lines.push(bullet(item, repository, scopeless))
    lines.push('')
  }

  const breaking = entry.commits.filter((commit) => commit.breaking)
  if (breaking.length) {
    lines.push('### ⚠️ BREAKING CHANGES', '')
    for (const commit of breaking) {
      const notes = commit.breakingNotes.length ? commit.breakingNotes : [commit.subject]
      for (const note of notes)
        lines.push(`* ${scope(commit, scopeless)}${note} (${link(commit, repository)})`)
    }
    lines.push('')
  }

  return lines
}

function bullet(item, repository, scopeless) {
  // A dependency note is synthetic: it has text and no commit behind it.
  if (item.note) return `* ${item.note}`
  return `* ${scope(item, scopeless)}${item.subject} (${link(item, repository)})`
}

/**
 * A package's own changelog drops the scope prefix — every line in it is that package by
 * definition, and `**compiler:**` on every bullet of `@weftjs/compiler/CHANGELOG.md` is noise. A
 * multi-scope commit keeps the other scopes, because knowing what moved with it is the point.
 */
function scope(commit, scopeless) {
  if (!commit.scopes?.length) return ''
  const shown = scopeless ? commit.scopes.filter((name) => name !== scopeless) : commit.scopes
  if (!shown.length) return ''
  return `**${shown.join(', ')}:** `
}

const link = (commit, repository) =>
  `[${commit.short}](https://github.com/${repository.owner}/${repository.name}/commit/${commit.sha})`

const compareUrl = (repository, from, to) =>
  `https://github.com/${repository.owner}/${repository.name}/compare/${from}...${to}`

export function writeChangelog(relativeDirectory, contents) {
  const path = relativeDirectory ? join(ROOT, relativeDirectory, 'CHANGELOG.md') : join(ROOT, 'CHANGELOG.md')
  writeFileSync(path, contents)
  return path
}

export function readChangelog(relativeDirectory) {
  const path = relativeDirectory ? join(ROOT, relativeDirectory, 'CHANGELOG.md') : join(ROOT, 'CHANGELOG.md')
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** The section for one version, lifted out of a rendered changelog — the body a GitHub release wants. */
export function sectionFor(contents, version) {
  const lines = contents.split('\n')
  const start = lines.findIndex(
    (line) => line.startsWith(`## [${version}]`) || line.startsWith(`## ${version} `),
  )
  if (start === -1) return ''
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith('## '))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim()
}
