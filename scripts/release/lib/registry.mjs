import { join } from 'node:path'

import { run, runVisible } from './shell.mjs'
import { ROOT } from './workspace.mjs'

/** The npm account this release would publish as, or undefined if nobody is logged in. */
export function whoami() {
  const result = run('npm', ['whoami'], { allowFailure: true })
  return result.ok ? result.stdout.trim() : undefined
}

const TOKEN_ADVICE =
  'Generate a classic Automation token at npmjs.com/settings/~/tokens — those bypass the code and ' +
  'cover every package — and export it as NPM_TOKEN.'

/**
 * Whether this account can publish, unattended, every name this release needs.
 *
 * `auth-and-writes` means npm demands a fresh code per publish, after the commit/tag/push already
 * happened — so a release that can't answer the prompt has already made itself irreversible. This
 * used to exempt anything with a token present, assuming a token bypasses the prompt; that cost a
 * release when a `bypass_2fa: false` token scoped to `@weftjs` let 8 packages stop on the prompt and
 * the 9th (unscoped `create-weft`) come back 403 — both facts were in `npm token list --json` the
 * whole time. Now a token must say it bypasses the code and covers every name.
 */
export function canPublishUnattended(names = [], otp) {
  if (otp) return { ok: true, why: 'a one-time password was supplied with --otp' }

  // A terminal can answer the prompt. `pnpm publish` fails with `ERR_PNPM_OTP_NON_INTERACTIVE`
  // otherwise, so this used to also wrongly refuse the ordinary interactive case.
  if (process.stdin.isTTY) return { ok: true, why: 'a terminal is attached, so npm can ask' }

  const token = process.env.NPM_TOKEN ?? process.env.NODE_AUTH_TOKEN

  // Asked only when there is no token: `npm profile get` fails under a token, so checking it first
  // and treating the failure as "fine" is how a `bypass_2fa: false` token sailed through before.
  if (!token) {
    const profile = run('npm', ['profile', 'get'], { allowFailure: true })
    const mode = profile.ok ? /two-factor auth:\s*(\S+)/.exec(profile.stdout)?.[1] : undefined
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
 * `npm token list --json` masks the token, so a row can't be matched by comparing values directly.
 * The human listing prints a truncated form and both commands return rows in the same order, so the
 * truncation is matched there and the capability read off the row at that index.
 */
function tokenCapability(token) {
  const listed = run('npm', ['token', 'list', '--json'], { allowFailure: true })
  const human = run('npm', ['token', 'list'], { allowFailure: true })
  if (!listed.ok || !human.ok) return undefined

  let rows
  try {
    rows = JSON.parse(listed.stdout)
  } catch {
    return undefined
  }
  if (!Array.isArray(rows) || !rows.length) return undefined

  const head = token.slice(0, 8)
  const tail = token.slice(-4)
  const lines = human.stdout.split('\n').filter((line) => line.trim().startsWith('Token '))
  let index = lines.findIndex((line) => line.includes(head) && line.includes(tail))
  // A single token needs no matching, and is the common case for a machine that publishes.
  if (index === -1 && rows.length === 1) index = 0
  const row = rows[index]
  if (!row) return undefined

  const scopes = (row.scopes ?? []).map((entry) => entry?.name).filter((name) => typeof name === 'string')
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
    return JSON.parse(result.stdout) === version
  } catch {
    return false
  }
}

/** Every version of a package the registry currently serves. */
export function publishedVersions(name) {
  const result = run('npm', ['view', name, 'versions', '--json'], { allowFailure: true })
  if (!result.ok) return []
  try {
    const value = JSON.parse(result.stdout)
    return Array.isArray(value) ? value : [value]
  } catch {
    return []
  }
}

/**
 * Whether this account may publish under a scope.
 *
 * Not `npm access list packages <scope>` — that's a public listing that answers for `@babel` as
 * readily as for your own, so a scope somebody else already holds comes back an empty success. That
 * read told this repo `@weft/*` was free when it wasn't, through a rename, a rehearsal and a push.
 * `npm org ls` distinguishes the three cases instead: fails for no such org, succeeds with a roster
 * for one you belong to, succeeds empty for one you don't.
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
  if (!org.stdout.trim()) {
    return {
      ok: false,
      why: `the @${scope} scope exists and ${user ?? 'this account'} is not a member of it. Publishing would be refused.`,
    }
  }
  return { ok: true, why: `a member of @${scope}` }
}

/** Whether this account could publish this name at all — catches "somebody else owns it" before the release becomes irreversible. */
export function claim(name, user) {
  if (name.startsWith('@')) {
    const scope = claimScope(name.slice(1).split('/')[0], user)
    if (!scope.ok) return scope
  }

  const existing = run('npm', ['view', name, 'version'], { allowFailure: true })
  if (!existing.ok) return { ok: true, why: 'the name is free' }

  const owners = run('npm', ['owner', 'ls', name], { allowFailure: true })
  const maintainers = owners.stdout
    .split('\n')
    .map((line) => line.split(' ')[0].trim())
    .filter(Boolean)
  if (user && maintainers.includes(user)) {
    return { ok: true, why: `already yours, at ${existing.stdout.trim()}` }
  }
  return {
    ok: false,
    why: `npm already serves ${name}@${existing.stdout.trim()}, owned by ${maintainers.join(', ') || 'somebody else'}. Rename, or have it transferred.`,
  }
}

/** Publish one package. `--no-git-checks`: the checks that matter (clean tree, branch, in sync) already ran in preflight, before anything was written. */
export function publish(pkg, { dryRun, otp }) {
  return runVisible(
    'pnpm',
    [
      'publish',
      '--no-git-checks',
      '--access',
      'public',
      // npm accepts the same OTP for every request inside its window — why one code publishes all nine packages.
      ...(otp ? ['--otp', otp] : []),
      ...(dryRun ? ['--dry-run'] : []),
    ],
    { cwd: join(ROOT, pkg.relativeDirectory), allowFailure: true },
  )
}

/** Whether this version is the only one the registry serves — removing it removes the package, and npm needs `--force` for that. */
export function isOnlyVersion(name, version) {
  const versions = publishedVersions(name)
  return versions.length === 1 && versions[0] === version
}

/**
 * Remove a version from the registry. npm allows this for 72 hours and only if nothing depends on
 * it; it does not free the number — `name@version` can never be published again once it existed, so
 * the next release needs a new one. `--force` only for the package's last version, npm's one protected case.
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
