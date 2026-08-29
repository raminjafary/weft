import { join } from 'node:path'

import { FRAMEWORK_PACKAGE, GATES, RELEASE_BRANCH } from './config.mjs'
import { commitsIn, releaseTags, today, unknownScopes } from './lib/commits.mjs'
import { readChangelog, renderChangelog, sectionFor, writeChangelog } from './lib/changelog.mjs'
import { packageEntries, releaseBoundaries, rootEntries, versionsAtBoundaries } from './lib/history.mjs'
import * as github from './lib/github.mjs'
import { auditPack, humanBytes } from './lib/pack.mjs'
import { buildPlan, bump } from './lib/plan.mjs'
import * as registry from './lib/registry.mjs'
import { renderVersionTable, writeVersionTable } from './lib/readme.mjs'
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
import { ROOT, loadWorkspace, publishOrder, readJson, scopeOf, writeJson } from './lib/workspace.mjs'

const FLAGS = ['dry-run', 'first-release', 'publish-only', 'no-github', 'no-gates', 'otp', 'yes', 'help']

const USAGE = `
${bold('pnpm release')}            cut a release: bump, changelog, commit, tag, push, publish, GitHub release
${bold('pnpm release:dry')}        the same, writing nothing and publishing nothing

  --first-release   keep the versions the manifests already carry (this is how 0.1.0 is cut)
  --publish-only    skip versioning; publish the current versions and finish the GitHub release
  --no-github       do not create the GitHub release
  --no-gates        skip format, lint, typecheck, build and test. For finishing a partial release only
  --otp <code>      an npm one-time password, for an account whose 2FA covers writes
  --yes             do not stop for confirmation
`

async function main() {
  const { flags } = parseArgs(process.argv.slice(2), FLAGS)
  if (flags.help) return say(USAGE)

  const dryRun = Boolean(flags['dry-run'])
  const repository = github.repositoryFromRemote()
  const packages = loadWorkspace()
  const rootManifest = readJson(join(ROOT, 'package.json'))

  say(bold(`\nweft release ${dryRun ? dim('(dry run — nothing is written or published)') : ''}`))
  say(dim(`  ${repository.owner}/${repository.name}`))

  const tags = releaseTags()
  const firstRelease = Boolean(flags['first-release']) || tags.length === 0
  const range = tags.length ? `${tags.at(-1)}..HEAD` : undefined

  // In a dry run a failed check is reported and the run continues; the same check aborts a real release.
  const blockers = []
  const refuse = (message) => {
    if (dryRun) {
      blockers.push(message)
      warn(message)
    } else fail(message)
  }

  step('Preflight')
  preflight({ dryRun, publishOnly: Boolean(flags['publish-only']), refuse })
  const npmUser = registry.whoami()
  if (npmUser) ok(`npm: ${npmUser}`)
  else refuse('not logged in to npm. Run `npm login` first.')
  if (flags['no-github']) warn('github release skipped by --no-github')
  else {
    try {
      ok(`github: ${await github.checkToken(repository)}`)
    } catch (error) {
      refuse(error.message)
    }
  }

  const commits = commitsIn(range)
  const unknown = unknownScopes(commits)
  if (unknown.length)
    fail(
      `commit scopes with no package and no repository meaning: ${unknown.join(', ')}. Add them to scripts/release/config.mjs.`,
    )

  if (flags['publish-only']) {
    const version = rootManifest.version
    step(`Publishing the current versions (v${version})`)
    const published = [...packages.values()].filter((pkg) => !pkg.isPrivate)
    await publishAll({
      packages,
      published: published.map((pkg) => ({ name: pkg.name, package: pkg, to: pkg.version })),
      dryRun,
      otp: flags.otp,
    })
    if (!flags['no-github']) await announce({ repository, version, dryRun, packages })
    return
  }

  step('What has changed')
  if (firstRelease) {
    say(`  no ${bold('v*')} tag in this repository — this is the first release.`)
    say(
      `  ${commits.length} commits, from ${dim(commits.at(-1)?.short ?? '?')} to ${dim(commits[0]?.short ?? '?')}.`,
    )
  } else {
    say(`  ${commits.length} commits since ${bold(tags.at(-1))}.`)
  }
  if (!commits.length) {
    ok('nothing to release.')
    return
  }

  const plan = buildPlan({ packages, commits, firstRelease })
  const framework = packages.get(FRAMEWORK_PACKAGE)
  if (!framework)
    fail(`no ${FRAMEWORK_PACKAGE} in packages/. Update FRAMEWORK_PACKAGE in scripts/release/config.mjs.`)

  /**
   * The tag is the framework's version, not a number of the repository's own. It used to be the
   * latter, bumped by the highest level any commit asked for — a `feat` scoped `repo` once moved
   * the tag a minor while every published package moved a patch, tagging `v0.2.0` over nine packages
   * at `0.1.1`. `@weftjs/core` depends on the whole graph, so anything published moves it and the two
   * agree by construction; the exception is a release touching only `create-weft`, where the
   * framework is added at a patch so the release has a number to mean.
   */
  let frameworkRelease = plan.releases.find((entry) => entry.name === FRAMEWORK_PACKAGE)
  if (!firstRelease && !frameworkRelease) {
    frameworkRelease = {
      name: framework.name,
      package: framework,
      level: 'patch',
      from: framework.version,
      to: bump(framework.version, 'patch'),
      commits: [],
      propagatedFrom: [],
      direct: false,
    }
    plan.releases.push(frameworkRelease)
    plan.published.push(frameworkRelease)
    warn(`nothing changed ${FRAMEWORK_PACKAGE}; moving it a patch so the tag has a version to be`)
  }
  const version = firstRelease ? framework.version : frameworkRelease.to
  const tag = `v${version}`
  if (tags.includes(tag))
    refuse(
      `${tag} already exists. A release that got this far is finished with \`pnpm release --publish-only\`, or undone with \`pnpm release:undo ${tag}\`.`,
    )

  printPlan(plan, { version, firstRelease })
  if (!plan.published.length) {
    warn('no published package changed. The commits in this range are repository-level.')
    if (!flags.yes && !dryRun)
      fail('nothing would reach the registry. Re-run with --yes to tag and push anyway.')
  }

  if (flags['no-gates']) warn('gates skipped by --no-gates')
  else runGates()

  step('Tarball audit')
  const audits = new Map()
  for (const release of plan.published) {
    const audit = auditPack(release.package)
    audits.set(release.name, audit)
    if (audit.problems.length) {
      bad(`${release.name} — ${audit.entries.length} entries, ${humanBytes(audit.bytes)}`)
      for (const problem of audit.problems) say(`      ${problem}`)
    } else {
      ok(`${release.name} — ${audit.entries.length} entries, ${humanBytes(audit.bytes)}`)
    }
  }
  const broken = [...audits.values()].filter((audit) => audit.problems.length)
  if (broken.length)
    fail(
      `${broken.length} package(s) would publish something this repository does not intend to. Fix \`files\` or scripts/release/config.mjs.`,
    )

  /**
   * A package nothing changed is still a package the registry has to have. The plan only holds what
   * moved — right for versioning, wrong for publishing: after a tagged-and-pushed release that failed
   * to publish, the next one bumps only what changed since, leaving `@weftjs/core@0.1.1` pinning an
   * unpublished `@weftjs/ir@0.1.0` — uninstallable, and npm accepts it without complaint. So anything
   * whose current version is missing is added unbumped, making the release self-healing.
   */
  step('Already on the registry')
  const planned = new Set(plan.published.map((release) => release.name))
  for (const pkg of packages.values()) {
    if (pkg.isPrivate || planned.has(pkg.name)) continue
    if (registry.isPublished(pkg.name, pkg.version)) continue
    warn(`${pkg.name}@${pkg.version} is not on the registry; publishing it unbumped`)
    plan.published.push({ name: pkg.name, package: pkg, to: pkg.version, from: pkg.version })
  }
  if (plan.published.length === planned.size) ok('every package a release depends on is there')

  step('Names on the registry')
  for (const release of plan.published) {
    const claim = registry.claim(release.name, npmUser)
    if (claim.ok) ok(`${release.name} — ${claim.why}`)
    else refuse(`${release.name}: ${claim.why}`)
  }
  // Asked with the names in hand: a token scoped to one organisation answers yes for eight of these and 403 for the ninth.
  const unattended = registry.canPublishUnattended(
    plan.published.map((release) => release.name),
    flags.otp,
  )
  if (unattended.ok) ok(`unattended: ${unattended.why}`)
  else refuse(unattended.why)

  const boundaries = releaseBoundaries({ version, date: today() })
  const versionsAt = versionsAtBoundaries(packages, boundaries, plan)
  const rootChangelog = renderChangelog({ entries: rootEntries(boundaries), repository })
  const section = sectionFor(rootChangelog, version)

  if (dryRun) {
    step(`CHANGELOG.md — the ${tag} entry`)
    say(indent(section))
    step('README.md — the version table')
    say(
      indent(
        renderVersionTable(packages, new Map(plan.releases.map((release) => [release.name, release.to]))),
      ),
    )
    step('Would publish')
    for (const candidate of publishOrder(packages)) {
      const release = plan.published.find((entry) => entry.name === candidate)
      if (!release) continue
      const already = registry.isPublished(candidate, release.to) ? dim(' (already on the registry)') : ''
      say(`  ${candidate}@${release.to}${already}`)
    }
    step('Would then')
    say(`  git commit -m "chore(release): ${tag}"`)
    say(`  git tag -a ${tag}`)
    say(`  git push origin ${RELEASE_BRANCH} --follow-tags`)
    say(`  publish ${plan.published.length} package(s) to npm as ${npmUser ?? dim('(nobody logged in)')}`)
    if (!flags['no-github']) say(`  create the GitHub release ${tag}`)
    say(
      dim(
        `\n  Pushing ${RELEASE_BRANCH} is what deploys the documentation site; Vercel builds from the push.`,
      ),
    )
    if (blockers.length) {
      step('This would not release yet')
      for (const blocker of blockers) bad(blocker)
      say(bold('\nDry run complete. Nothing was written, and the checks above would stop a real run.\n'))
      process.exitCode = 1
      return
    }
    say(bold('\nDry run complete. Nothing was written.\n'))
    return
  }

  step('Writing')
  for (const release of plan.releases) {
    const manifest = readJson(release.package.manifestPath)
    manifest.version = release.to
    writeJson(release.package.manifestPath, manifest)
  }
  rootManifest.version = version
  writeJson(join(ROOT, 'package.json'), rootManifest)
  ok(`versions: ${plan.releases.length} package manifest(s), and the root at ${version}`)

  writeChangelog(undefined, rootChangelog)
  let changelogs = 1
  for (const pkg of packages.values()) {
    const entries = packageEntries(pkg, boundaries, versionsAt)
    if (!entries.length) continue
    writeChangelog(pkg.relativeDirectory, renderChangelog({ entries, repository, scopeless: scopeOf(pkg) }))
    changelogs++
  }
  ok(`changelogs: ${changelogs}`)

  const table = writeVersionTable(
    renderVersionTable(packages, new Map(plan.releases.map((release) => [release.name, release.to]))),
  )
  ok(`README.md version table${table.changed ? '' : ' (unchanged)'}`)

  step('Commit and tag')
  run('git', ['add', '--all'], { cwd: ROOT })
  run('git', ['commit', '-m', `chore(release): ${tag}`], { cwd: ROOT })
  run('git', ['tag', '-a', tag, '-m', `${tag}\n\n${section}`], { cwd: ROOT })
  ok(`${run('git', ['rev-parse', '--short', 'HEAD']).stdout.trim()} chore(release): ${tag}`)

  // Push before publishing: a lost push after a real publish burns version numbers npm never accepts again.
  step('Push')
  runVisible('git', ['push', 'origin', `${RELEASE_BRANCH}`, '--follow-tags'], { cwd: ROOT })
  ok(`${RELEASE_BRANCH} and ${tag} are on origin. The documentation site deploys from this push.`)

  step('Publish')
  await publishAll({ packages, published: plan.published, dryRun: false, otp: flags.otp })

  if (!flags['no-github']) await announce({ repository, version, dryRun: false, packages, section })

  say(bold(`\nReleased ${tag}.\n`))
  for (const release of plan.published) say(`  ${release.name}@${release.to}`)
  say(dim(`\n  If any of this is wrong: pnpm release:undo ${tag}\n`))
}

/** Everything that must be true before a release writes anything. Cheapest-first; a failure here has changed nothing. */
function preflight({ dryRun, publishOnly, refuse }) {
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim()
  if (branch === RELEASE_BRANCH) ok(`branch: ${branch}`)
  else refuse(`releases are cut from ${RELEASE_BRANCH}; this is ${branch}.`)

  const dirty = run('git', ['status', '--porcelain']).stdout.trim()
  if (dirty) refuse(`the working tree is not clean (${dirty.split('\n').length} path(s) changed).`)
  else ok('working tree clean')

  run('git', ['fetch', 'origin', RELEASE_BRANCH, '--tags'], { cwd: ROOT })
  const counts = run('git', ['rev-list', '--left-right', '--count', `origin/${RELEASE_BRANCH}...HEAD`])
    .stdout.trim()
    .split(/\s+/)
  const [behind, ahead] = counts.map(Number)
  if (behind > 0) refuse(`${behind} commit(s) on origin/${RELEASE_BRANCH} are not here. Pull first.`)
  else ok(`in sync with origin/${RELEASE_BRANCH}${ahead ? ` (${ahead} to push)` : ''}`)

  if (!publishOnly && !dryRun && ahead === 0) warn('nothing to push; the release commit will be the only one')

  const lock = run('pnpm', ['install', '--frozen-lockfile', '--offline', '--ignore-scripts', '--dry-run'], {
    cwd: ROOT,
    allowFailure: true,
  })
  if (!lock.ok) warn('pnpm could not confirm the lockfile offline; the gates will catch a real mismatch')
  else ok('lockfile matches the manifests')
}

/** The plan, with the reason each package is in it — whether a bump was asked for or forced by a dependency, which the version numbers alone don't say. */
function printPlan(plan, { version, firstRelease }) {
  step(`Plan — ${bold(`v${version}`)}`)
  if (!firstRelease) say(dim(`  the tag is ${FRAMEWORK_PACKAGE}'s version, and the repository follows it`))
  for (const release of plan.releases) {
    const visibility = release.package.isPrivate ? dim(' private') : ''
    const reason = release.direct
      ? `${release.commits.length} commit(s)`
      : `for ${release.propagatedFrom.join(', ')}`
    const move = release.from === release.to ? release.to : `${release.from} → ${release.to}`
    say(`  ${release.name.padEnd(16)} ${move.padEnd(24)} ${dim(reason)}${visibility}`)
  }
  say(
    dim(
      `\n  ${plan.published.length} to the registry, ${plan.releases.length - plan.published.length} private`,
    ),
  )
}

function runGates() {
  for (const gate of GATES) {
    step(`Gate: ${gate.script} ${dim(`— ${gate.why}`)}`)
    runVisible('pnpm', ['run', gate.script], { cwd: ROOT })
  }
}

async function publishAll({ packages, published, dryRun, otp }) {
  const order = publishOrder(packages)
  const sorted = [...published].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name))
  const failures = []
  for (const release of sorted) {
    if (registry.isPublished(release.name, release.to)) {
      ok(`${release.name}@${release.to} is already on the registry`)
      continue
    }
    say(dim(`  publishing ${release.name}@${release.to} …`))
    const result = registry.publish(release.package, { dryRun, otp })
    if (result.ok) ok(`${release.name}@${release.to}`)
    else {
      bad(`${release.name}@${release.to} failed`)
      failures.push(release.name)
    }
  }
  if (failures.length) {
    fail(
      `${failures.join(', ')} did not publish. The commit and tag are pushed, so finish with ` +
        `\`pnpm release --publish-only\` once the cause is fixed — already-published packages are skipped.`,
    )
  }
}

async function announce({ repository, version, dryRun, packages, section }) {
  const tag = `v${version}`
  step('GitHub release')
  const body = section ?? sectionFor(readChangelog(undefined), version) ?? ''
  const listing = [...packages.values()]
    .filter((pkg) => !pkg.isPrivate)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((pkg) => `- \`${pkg.name}@${pkg.version}\``)
    .join('\n')
  const text = `### On npm\n\n${listing}\n\n${body}`
  if (dryRun) {
    say(indent(text))
    return
  }
  const result = await github.upsertRelease(repository, {
    tag,
    name: tag,
    body: text,
    prerelease: version.startsWith('0.0.'),
  })
  ok(`${result.updated ? 'updated' : 'created'} ${result.url}`)
}

const indent = (text) =>
  text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')

main().catch((error) => {
  say('')
  bad(error instanceof ReleaseError ? error.message : (error?.stack ?? String(error)))
  say('')
  process.exit(1)
})
