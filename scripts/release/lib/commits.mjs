import { REPOSITORY_SCOPES, SCOPE_DIRECTORIES } from '../config.mjs'
import { run } from './shell.mjs'

/** ASCII record and unit separators: git writes them with %x1e/%x1f, and no commit message holds one. */
const RECORD = '\u001e'
const FIELD = '\u001f'

const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<breaking>!)?:\s*(?<subject>.+)$/

/** Every directory in `SCOPE_DIRECTORIES`, longest first, so `packages/create-weft` beats nothing. */
const DIRECTORIES = [...new Set(Object.values(SCOPE_DIRECTORIES))].sort((a, b) => b.length - a.length)

/**
 * Which packages a commit changed files in, asked of git rather than of its subject line.
 *
 * A scope is what the author wrote and the files are what they did, and the two can disagree: a fix
 * to the client's framing that also hardens the decoder it talks to is one change with one subject,
 * and `fix(weft)` is an honest way to write it. But the plan bumped packages from scopes alone, so
 * the decoder half was committed, tagged, and never published — the release said nothing, because
 * from its point of view nothing in `packages/warp` had happened.
 *
 * So both are asked and the answer is the union. A scope may still name a package this commit did
 * not touch, which is deliberate: an author saying `fix(kernel)` about a change made elsewhere is
 * making a claim about who is affected, and that claim is not this function's to overrule.
 */
function touched(sha) {
  const { output } = run('git', ['show', '--pretty=format:', '--name-only', sha])
  const changed = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const found = new Set()
  for (const file of changed) {
    const directory = DIRECTORIES.find((dir) => file === dir || file.startsWith(`${dir}/`))
    if (!directory) continue
    // Only what the package publishes. A commit that touches `test/` alone changes nothing anybody
    // installs — every manifest here ships `dist` — so bumping for it would be version churn with a
    // changelog entry attached, and the whole point of asking git is to catch a *shipped* change
    // nobody named.
    const within = file.slice(directory.length + 1)
    if (/^(test|tests)\//.test(within)) continue
    found.add(directory)
  }
  return [...found]
}

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
      packages: touched(raw.sha),
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
    packages: [...new Set([...scopes.map((s) => SCOPE_DIRECTORIES[s]).filter(Boolean), ...touched(raw.sha)])],
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
