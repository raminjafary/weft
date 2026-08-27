import { RELEASE_BRANCH } from './config.mjs'
import * as github from './lib/github.mjs'
import * as registry from './lib/registry.mjs'
import {
  ReleaseError,
  bad,
  bold,
  dim,
  fail,
  ok,
  parseArgs,
  run,
  runVisible,
  say,
  step,
  warn,
} from './lib/shell.mjs'
import { ROOT, loadWorkspace, manifestAt } from './lib/workspace.mjs'

const FLAGS = ['yes', 'deprecate', 'keep-git', 'keep-registry', 'keep-github', 'reset', 'help']

const USAGE = `
${bold('pnpm release:undo <tag>')}   take back a release. Prints a plan and stops; add --yes to run it

  --yes             actually do it
  --deprecate       deprecate the versions instead of unpublishing them (use once the 72h window closed)
  --keep-registry   leave npm alone
  --keep-github     leave the GitHub release alone
  --keep-git        leave the tag and the release commit alone
  --reset           drop the release commit with a hard reset instead of reverting it.
                    Only for a release that was never pushed

${bold('What it cannot undo')}

  npm never lets a version number be published twice, even after an unpublish. Once ${bold('weft@0.1.0')}
  has existed, ${bold('weft@0.1.0')} is gone forever and the next release has to be a new number. That is
  why this command exists as a repair for a bad publish and not as an alternative to --dry-run.
`

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2), FLAGS)
  if (flags.help) return say(USAGE)

  const tag = positional[0]
  if (!tag) fail(`which release? e.g. \`pnpm release:undo v0.1.0\`.\n${USAGE}`)
  if (!/^v\d+\.\d+\.\d+/.test(tag)) fail(`${tag} is not a release tag. They look like v0.1.0.`)

  const commit = run('git', ['rev-list', '-n', '1', tag], { allowFailure: true })
  if (!commit.ok) fail(`no tag ${tag} in this repository.`)
  const sha = commit.output.trim()

  const repository = github.repositoryFromRemote()
  const packages = loadWorkspace()
  const dryRun = !flags.yes

  const subject = run('git', ['log', '-1', '--format=%s', sha]).output.trim()
  say(bold(`\nundo ${tag}${dryRun ? ` ${dim('(plan only — add --yes to run it)')}` : ''}`))
  say(dim(`  ${repository.owner}/${repository.name} — ${sha.slice(0, 9)} ${subject}`))
  // A tag that does not sit on a release commit is a tag somebody moved, or a tag on the wrong
  // commit. Reverting it would revert real work, so it is named before anything is planned.
  if (!subject.startsWith('chore(release):')) {
    warn(`${tag} is not on a \`chore(release):\` commit. Reverting it would revert ${subject.slice(0, 60)}.`)
  }

  // What that release put on the registry, read from the tagged tree rather than from the current
  // manifests: the point of undoing is that the current tree may already have moved on.
  const onRegistry = []
  for (const pkg of packages.values()) {
    const manifest = manifestAt(tag, pkg.relativeDirectory)
    if (!manifest || manifest.private === true) continue
    onRegistry.push({ name: manifest.name, version: manifest.version })
  }

  step('On npm')
  const live = []
  for (const entry of onRegistry.sort((a, b) => a.name.localeCompare(b.name))) {
    const published = registry.isPublished(entry.name, entry.version)
    say(`  ${published ? '' : dim('(not on the registry) ')}${entry.name}@${entry.version}`)
    if (published) live.push(entry)
  }
  if (!live.length) say(dim('  nothing that release published is on the registry.'))

  step('On GitHub')
  // A missing token is reported rather than fatal: the npm and git halves of an undo are worth doing
  // on their own, and the release on GitHub can be deleted by hand.
  let release
  if (flags['keep-github']) say(dim('  left alone by --keep-github'))
  else {
    try {
      release = await github.releaseByTag(repository, tag)
      say(release ? `  ${release.html_url}` : dim('  no release for that tag'))
    } catch (error) {
      warn(error.message)
    }
  }

  step('In git')
  const remoteTag = run('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], {
    allowFailure: true,
  }).output.trim()
  const onRemote = run('git', ['branch', '-r', '--contains', sha], { allowFailure: true })
  const pushed = onRemote.ok && onRemote.output.includes(`origin/${RELEASE_BRANCH}`)
  say(`  tag ${tag}: local${remoteTag ? ', and on origin' : dim(', not on origin')}`)
  say(`  commit ${sha.slice(0, 9)}: ${pushed ? `on origin/${RELEASE_BRANCH}` : dim('local only')}`)

  if (flags.reset && pushed)
    fail(
      `${sha.slice(0, 9)} is on origin/${RELEASE_BRANCH}. --reset would need a force push; revert it instead (drop --reset).`,
    )

  step('Plan')
  const steps = []
  if (!flags['keep-registry'] && live.length) {
    steps.push(
      flags.deprecate
        ? `deprecate ${live.length} version(s) on npm`
        : `unpublish ${live.length} version(s) from npm — ${bold('those version numbers are then unusable forever')}`,
    )
  }
  if (release) steps.push('delete the GitHub release')
  if (!flags['keep-git']) {
    if (remoteTag) steps.push(`delete ${tag} from origin`)
    steps.push(`delete ${tag} locally`)
    steps.push(flags.reset ? `git reset --hard ${sha}~1` : `git revert --no-edit ${sha.slice(0, 9)}`)
  }
  if (!steps.length) {
    ok('nothing left to undo.')
    return
  }
  for (const line of steps) say(`  · ${line}`)

  if (dryRun) {
    say(bold(`\nNothing was done. Re-run with --yes.\n`))
    return
  }

  if (!flags['keep-registry'] && live.length) {
    step(flags.deprecate ? 'Deprecating' : 'Unpublishing')
    for (const entry of live) {
      const result = flags.deprecate
        ? registry.deprecate(
            entry.name,
            entry.version,
            `${entry.version} was withdrawn; use a later version.`,
            { dryRun: false },
          )
        : registry.unpublish(entry.name, entry.version, { dryRun: false })
      if (result.ok) ok(`${entry.name}@${entry.version}`)
      else {
        bad(`${entry.name}@${entry.version}`)
        say(`      ${result.output.split('\n').slice(0, 4).join('\n      ')}`)
        // The 72-hour window is the usual cause, and deprecating is the honest fallback.
        if (!flags.deprecate && /24 hours|72 hours|cannot be removed|not allowed/i.test(result.output)) {
          warn('npm will not remove this version. Re-run with --deprecate to warn installers instead.')
        }
      }
    }
  }

  if (release) {
    step('GitHub')
    const result = await github.deleteRelease(repository, tag)
    ok(result.deleted ? `deleted ${result.url}` : result.reason)
  }

  if (!flags['keep-git']) {
    step('Git')
    if (remoteTag) {
      runVisible('git', ['push', 'origin', `:refs/tags/${tag}`], { cwd: ROOT })
      ok(`${tag} removed from origin`)
    }
    run('git', ['tag', '-d', tag], { cwd: ROOT })
    ok(`${tag} removed locally`)

    const dirty = run('git', ['status', '--porcelain']).output.trim()
    if (dirty) {
      warn(`the working tree is not clean, so the release commit was left alone:\n\n${dirty}`)
    } else if (flags.reset) {
      run('git', ['reset', '--hard', `${sha}~1`], { cwd: ROOT })
      ok(`reset to ${run('git', ['rev-parse', '--short', 'HEAD']).output.trim()}`)
    } else {
      const revert = run('git', ['revert', '--no-edit', sha], { cwd: ROOT, allowFailure: true })
      if (revert.ok) {
        ok(`reverted as ${run('git', ['rev-parse', '--short', 'HEAD']).output.trim()}`)
        say(dim(`      push it: git push origin ${RELEASE_BRANCH}`))
      } else {
        warn(`the revert did not apply cleanly; the release commit is still in place.\n\n${revert.output}`)
      }
    }
  }

  say(bold(`\n${tag} undone.`))
  if (!flags.deprecate && live.length) {
    say(
      `\n  ${bold('The next release cannot reuse these numbers.')} npm refuses a version it has served once,`,
    )
    say(`  even after an unpublish. Cut the fix as a new version.\n`)
  }
}

main().catch((error) => {
  say('')
  bad(error instanceof ReleaseError ? error.message : (error?.stack ?? String(error)))
  say('')
  process.exit(1)
})
