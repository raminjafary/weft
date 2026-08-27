import { today } from './lib/commits.mjs'
import { readChangelog, renderChangelog, writeChangelog } from './lib/changelog.mjs'
import { packageEntries, releaseBoundaries, rootEntries, versionsAtBoundaries } from './lib/history.mjs'
import { repositoryFromRemote } from './lib/github.mjs'
import { ReleaseError, bad, bold, dim, ok, parseArgs, say, step } from './lib/shell.mjs'
import { loadWorkspace, scopeOf } from './lib/workspace.mjs'

const FLAGS = ['unreleased', 'check', 'help']

const USAGE = `
${bold('pnpm changelog')}              regenerate every changelog from the git history
  --unreleased   include the commits since the last tag, under an "Unreleased" heading
  --check        write nothing; exit non-zero if any changelog is out of date
`

/**
 * Rebuild every changelog from the commit history.
 *
 * This is the repair tool. The changelog in this repository had drifted from git — it carried commit
 * links pointing at shas that no longer existed, because it had been generated before a history
 * rewrite. Regenerating from the tags is the only way that stays true, and it makes the release
 * step and the repair step the same code.
 */
function main() {
  const { flags } = parseArgs(process.argv.slice(2), FLAGS)
  if (flags.help) return say(USAGE)

  const repository = repositoryFromRemote()
  const packages = loadWorkspace()
  const pending = flags.unreleased ? { version: 'Unreleased', date: today() } : undefined
  const boundaries = releaseBoundaries(pending)

  if (!boundaries.length) {
    say('\nNo release tags and no --unreleased: there is nothing to write.\n')
    return
  }

  const versionsAt = versionsAtBoundaries(packages, boundaries, undefined)
  const files = [
    {
      directory: undefined,
      label: 'CHANGELOG.md',
      contents: renderChangelog({ entries: rootEntries(boundaries), repository }),
    },
  ]
  for (const pkg of packages.values()) {
    const entries = packageEntries(pkg, boundaries, versionsAt)
    if (!entries.length) continue
    files.push({
      directory: pkg.relativeDirectory,
      label: `${pkg.relativeDirectory}/CHANGELOG.md`,
      contents: renderChangelog({ entries, repository, scopeless: scopeOf(pkg) }),
    })
  }

  step(flags.check ? 'Checking changelogs' : 'Writing changelogs')
  let stale = 0
  for (const file of files) {
    if (flags.check) {
      const current = readChangelog(file.directory)
      if (current === file.contents) ok(file.label)
      else {
        bad(`${file.label} is out of date`)
        stale++
      }
      continue
    }
    writeChangelog(file.directory, file.contents)
    ok(file.label)
  }

  if (flags.check && stale) {
    say(`\n${stale} changelog(s) do not match the history. Run ${bold('pnpm changelog')}.\n`)
    process.exit(1)
  }
  say(dim(`\n  ${boundaries.length} release(s), ${files.length} file(s).\n`))
}

try {
  main()
} catch (error) {
  say('')
  bad(error instanceof ReleaseError ? error.message : (error?.stack ?? String(error)))
  say('')
  process.exit(1)
}
