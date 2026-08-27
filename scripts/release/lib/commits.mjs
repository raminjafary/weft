import { REPOSITORY_SCOPES, SCOPE_DIRECTORIES } from '../config.mjs'
import { run } from './shell.mjs'

/** ASCII record and unit separators: git writes them with %x1e/%x1f, and no commit message holds one. */
const RECORD = '\u001e'
const FIELD = '\u001f'

const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<breaking>!)?:\s*(?<subject>.+)$/

/**
 * Every commit in a range, parsed.
 *
 * The pre-conventional commits — the twelve before `build(repo): enforce conventional commits` —
 * do not match the header pattern. They are kept, typed `foundations`, rather than dropped: they
 * are the project's first month and a 0.1.0 changelog that begins after them is a changelog that
 * lies about when the work started.
 */
export function commitsIn(range) {
  const format = ['%H', '%h', '%s', '%b', '%aI', '%P'].join('%x1f') + '%x1e'
  const { output } = run('git', ['log', '--no-merges', `--format=${format}`, ...(range ? [range] : [])])
  const commits = []
  for (const record of output.split(RECORD)) {
    const trimmed = record.trim()
    if (!trimmed) continue
    const [sha, short, subject, body, date, parents] = trimmed.split(FIELD)
    const commit = parse({
      sha,
      short,
      subject,
      body: body ?? '',
      date,
      parents: (parents ?? '').split(' ').filter(Boolean),
    })
    if (commit) commits.push(commit)
  }
  return commits
}

function parse(raw) {
  const match = HEADER.exec(raw.subject)
  const breakingNotes = [...raw.body.matchAll(/^BREAKING[ -]CHANGE:\s*(.+)$/gm)].map((m) => m[1].trim())

  if (!match) {
    return {
      ...raw,
      type: 'foundations',
      scopes: [],
      packages: [],
      breaking: false,
      breakingNotes,
      subject: raw.subject,
    }
  }

  const { type, scope, breaking, subject } = match.groups
  // A release commit is bookkeeping. It is in the history and never in a changelog entry.
  if (type === 'chore' && scope === 'release') return undefined

  const scopes = (scope ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)

  return {
    ...raw,
    type,
    subject,
    scopes,
    packages: scopes.map((s) => SCOPE_DIRECTORIES[s]).filter(Boolean),
    breaking: breaking === '!' || breakingNotes.length > 0,
    breakingNotes,
  }
}

/** Scopes seen in a range that neither name a package nor are repository-level. */
export function unknownScopes(commits) {
  const found = new Set()
  for (const commit of commits) {
    for (const scope of commit.scopes) {
      if (!SCOPE_DIRECTORIES[scope] && !REPOSITORY_SCOPES.has(scope)) found.add(scope)
    }
  }
  return [...found]
}

/** The release tags, oldest first. Only `v<semver>` counts; anything else in `refs/tags` is somebody's bookmark. */
export function releaseTags() {
  const { output } = run('git', ['tag', '--list', 'v*', '--sort=creatordate'])
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(line))
}

/** The ISO date a tag points at, so a regenerated changelog dates each entry from history rather than from today. */
export function tagDate(tag) {
  const { output } = run('git', ['log', '-1', '--format=%aI', tag])
  return output.slice(0, 10)
}

export const today = () => new Date().toISOString().slice(0, 10)
