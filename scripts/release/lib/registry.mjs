import { join } from 'node:path'

import { run, runVisible } from './shell.mjs'
import { ROOT } from './workspace.mjs'

/** The npm account this release would publish as, or undefined if nobody is logged in. */
export function whoami() {
  const result = run('npm', ['whoami'], { allowFailure: true })
  return result.ok ? result.output.trim() : undefined
}

const TOKEN_ADVICE =
  'Generate a classic Automation token at npmjs.com/settings/~/tokens — those bypass the code and ' +
  'cover every package — and export it as NPM_TOKEN.'

/**
 * Whether this account can publish, unattended, every name this release needs.
 *
 * `auth-and-writes` means npm demands a fresh code for every publish. Nine packages is nine codes
 * inside a thirty-second window each, and the publish step runs *after* the commit, the tag and the
 * push — so the release that cannot answer the prompt is also the one that has already made itself
 * irreversible.
 *
 * The first version of this check exempted anything with a token in the environment, on the
 * assumption that a token bypasses the prompt. That assumption cost a release: the token was a
 * granular one with `bypass_2fa: false`, scoped to `@weftjs` alone, so eight packages stopped on the
 * prompt and the ninth — unscoped `create-weft` — came back 403. Both facts were sitting in
 * `npm token list --json` the whole time. Nothing is assumed here now: a token has to say it bypasses
 * the code, and it has to say it covers every name.
 *
 * The token itself is read from the environment rather than from `~/.npmrc`, because a token this
 * could parse is a token it could also print.
 */
export function canPublishUnattended(names = []) {
  const token = process.env.NPM_TOKEN ?? process.env.NODE_AUTH_TOKEN

  // The account's own setting, asked only when there is no token. `npm profile get` needs a login
  // session and fails under a token, so reading it first and treating the failure as "nothing to
  // worry about" is how a token with `bypass_2fa: false` sailed through this check.
  if (!token) {
    const profile = run('npm', ['profile', 'get'], { allowFailure: true })
    const mode = profile.ok ? /two-factor auth:\s*(\S+)/.exec(profile.output)?.[1] : undefined
    if (!mode) return { ok: true, why: 'npm would not say what its two-factor setting is' }
    if (mode !== 'auth-and-writes') return { ok: true, why: `two-factor auth: ${mode}` }
    return {
      ok: false,
      why: `npm two-factor auth is auth-and-writes, so every publish asks for a code. ${TOKEN_ADVICE}`,
    }
  }

  const capability = tokenCapability(token)
  if (!capability) {
    return {
      ok: false,
      why:
        'there is a token in the environment, but npm would not say whether it bypasses the ' +
        `two-factor code. Refusing rather than guessing: the guess is what broke the last release. ${TOKEN_ADVICE}`,
    }
  }
  if (!capability.bypass) {
    return {
      ok: false,
      why: `the token in the environment reports bypass_2fa: false, so every publish would stop on the code prompt. ${TOKEN_ADVICE}`,
    }
  }

  const uncovered = names.filter((name) => !capability.covers(name))
  if (uncovered.length) {
    return {
      ok: false,
      why:
        `the token in the environment does not cover ${uncovered.join(', ')} — it is limited to ` +
        `${capability.scopes.join(', ') || 'nothing'}. An unscoped package needs a token that covers all packages. ${TOKEN_ADVICE}`,
    }
  }
  return { ok: true, why: `a token that bypasses the code and covers all ${names.length} name(s)` }
}

/**
 * What the token in use is allowed to do, or undefined if npm will not say.
 *
 * `npm token list --json` masks the token itself, so a row cannot be matched to the configured value
 * by comparing them. The human listing does print a truncated form, and both commands return rows in
 * the same order — so the truncation is matched there and the capability read from the row at the
 * same index.
 */
function tokenCapability(token) {
  const listed = run('npm', ['token', 'list', '--json'], { allowFailure: true })
  const human = run('npm', ['token', 'list'], { allowFailure: true })
  if (!listed.ok || !human.ok) return undefined

  let rows
  try {
    rows = JSON.parse(listed.output)
  } catch {
    return undefined
  }
  if (!Array.isArray(rows) || !rows.length) return undefined

  const head = token.slice(0, 8)
  const tail = token.slice(-4)
  const lines = human.output.split('\n').filter((line) => line.trim().startsWith('Token '))
  let index = lines.findIndex((line) => line.includes(head) && line.includes(tail))
  // A single token needs no matching, and is the common case for a machine that publishes.
  if (index === -1 && rows.length === 1) index = 0
  const row = rows[index]
  if (!row) return undefined

  const scopes = (row.scopes ?? []).map((entry) => entry.name)
  return {
    bypass: row.bypass_2fa === true,
    scopes,
    // No scope list at all is npm's way of saying every package.
    covers: (name) =>
      scopes.length === 0 ||
      scopes.some((scope) => name === scope || (scope.startsWith('@') && name.startsWith(`${scope}/`))),
  }
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
 * Whether this account may publish under a scope.
 *
 * `npm access list packages <scope>` is not this check, though it looks like it: it is a public
 * listing that answers for `@babel` as readily as for your own, so an unpublished scope somebody else
 * holds comes back as an empty success. That read is what told this repository `@weft/*` was free
 * when it was not, through a rename, a release rehearsal and a push.
 *
 * `npm org ls` does distinguish the three cases, because membership is the thing it reports: it fails
 * for a scope that names no organisation, succeeds with the roster for one you belong to, and
 * succeeds empty for one you do not. A scope equal to your own username needs no organisation at all,
 * so it is answered before any of that.
 */
function claimScope(scope, user) {
  if (user && scope === user) return { ok: true, why: 'your own user scope' }

  const org = run('npm', ['org', 'ls', scope], { allowFailure: true })
  if (!org.ok) {
    return {
      ok: false,
      why: `no npm organisation named ${scope}. Create it at npmjs.com/org/create, or rename the package.`,
    }
  }
  if (!org.output.trim()) {
    return {
      ok: false,
      why: `the @${scope} scope exists and ${user ?? 'this account'} is not a member of it. Publishing would be refused.`,
    }
  }
  return { ok: true, why: `a member of @${scope}` }
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
    const scope = claimScope(name.slice(1).split('/')[0], user)
    if (!scope.ok) return scope
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
 * Whether this version is the only one the registry serves for this package.
 *
 * The answer changes what unpublishing means. Removing one of several versions leaves the package;
 * removing the only one removes the package itself, and npm asks for `--force` before it will. That
 * is the case for a first release, which is exactly when an undo is most likely to be needed.
 */
export function isOnlyVersion(name, version) {
  const versions = publishedVersions(name)
  return versions.length === 1 && versions[0] === version
}

/**
 * Remove a version from the registry.
 *
 * npm allows this for 72 hours after publishing, and only if nothing depends on it. It does not
 * free the version number: npm refuses to ever publish `name@version` again once that pair has
 * existed, so the next release has to be a new number. `release:undo` says so before it runs.
 *
 * `--force` is passed only when this is the package's last version, because that is the one case
 * npm protects and the protection is against something the caller has already been told about.
 */
export function unpublish(name, version, { dryRun }) {
  const last = isOnlyVersion(name, version)
  const args = ['unpublish', `${name}@${version}`, ...(last ? ['--force'] : [])]
  if (dryRun) return { ok: true, output: `would run: npm ${args.join(' ')}`, last }
  return { ...run('npm', args, { allowFailure: true }), last }
}

/** The fallback when the 72-hour window has closed: the version stays, and installing it warns. */
export function deprecate(name, version, message, { dryRun }) {
  if (dryRun) return { ok: true, output: `would run: npm deprecate ${name}@${version} "${message}"` }
  return run('npm', ['deprecate', `${name}@${version}`, message], { allowFailure: true })
}
