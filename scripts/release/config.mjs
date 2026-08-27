/**
 * What a release is, stated once.
 *
 * The release tooling is written here rather than delegated to a generic tool because this is a
 * workspace of eleven packages whose versions move independently: a commit scoped `compiler` has
 * to bump `@weftjs/compiler`, and then everything that depends on it, because pnpm rewrites
 * `workspace:*` to an exact version at pack time and a dependent left behind would publish a
 * dependency range pointing at a version it was never tested against.
 */

/**
 * Every type appears in the changelog, not only feat and fix. The conventional-changelog default
 * hides most of them, which produces a changelog reading as though nothing else happened — and in
 * this repository a docs or test commit is frequently the substantive one.
 *
 * The order here is the order of sections in a released entry.
 */
export const SECTIONS = [
  { type: 'feat', title: '✨ Features' },
  { type: 'fix', title: '🐛 Bug Fixes' },
  { type: 'perf', title: '⚡️ Performance Improvements' },
  { type: 'refactor', title: '♻️ Code Refactoring' },
  { type: 'docs', title: '📝 Documentation' },
  { type: 'test', title: '✅ Testing' },
  { type: 'build', title: '📦 Build & Dependencies' },
  { type: 'ci', title: '🔧 CI/CD' },
  { type: 'chore', title: '🚚 Chores' },
  { type: 'style', title: '💄 Styling' },
  { type: 'security', title: '🔒 Security' },
  { type: 'revert', title: '⏪ Reverts' },
  // Synthetic. Written by the changelog generator, never parsed from a commit.
  { type: 'deps', title: '⬆️ Workspace Dependencies' },
  // The twelve commits before `build(repo): enforce conventional commits`. They are the project's
  // first month and belong in 0.1.0; they simply predate the convention that would classify them.
  { type: 'foundations', title: '🌱 Foundations' },
]

/** Bump precedence, low to high. */
export const LEVELS = ['patch', 'minor', 'major']

/**
 * Commit scope to workspace directory.
 *
 * The list is closed on purpose — it mirrors `scope-enum` in commitlint.config.js, so a scope that
 * passes the commit hook is a scope this file can resolve. `spec`, `deps`, `repo` and `release`
 * resolve to nothing: they are repository-level and appear in the root changelog without bumping
 * any package.
 */
export const SCOPE_DIRECTORIES = {
  ir: 'packages/ir',
  warp: 'packages/warp',
  compiler: 'packages/compiler',
  client: 'packages/client',
  kernel: 'packages/kernel',
  plan: 'packages/plan',
  adapters: 'packages/adapters',
  bench: 'packages/bench',
  weft: 'packages/weft',
  create: 'packages/create-weft',
  inspector: 'packages/inspector',
  docs: 'packages/docs',
  demo: 'demo',
}

/** Scopes that are real, resolve to no package, and must not be reported as unknown. */
export const REPOSITORY_SCOPES = new Set(['repo', 'spec', 'deps', 'release'])

/**
 * What a published tarball may contain.
 *
 * `src` and the source maps beside `dist` are deliberately absent: an application needs the built
 * framework, not the framework's sources, and a `files` list is the only place that decision can be
 * enforced. `scripts/release/lib/pack.mjs` checks a real tarball against these, because `files` is
 * easy to get wrong in a way nothing else notices until it is on the registry.
 */
export const TARBALL_ALLOWED = [
  /^package\/package\.json$/,
  /^package\/(README|CHANGELOG|LICENSE)(\.md)?$/,
  /^package\/dist\/.+/,
  /^package\/bin\/.+/,
  /^package\/templates\/.+/,
]

/** Anything under here is a file the scaffold writes into somebody else's application, so this package's own rules do not apply to it. */
export const TARBALL_TEMPLATES = 'package/templates/'

/**
 * Entries that are never a release, whatever `files` says.
 *
 * `everywhere` is the difference between a rule about this package and a rule about any file at all.
 * A `tsconfig.json` beside `dist` is a build configuration that escaped; a `tsconfig.json` under
 * `templates/` is one of the files `weft create` writes, and forbidding it would forbid the scaffold.
 */
export const TARBALL_FORBIDDEN = [
  { pattern: /\.map$/, why: 'a source map with no source beside it', everywhere: true },
  { pattern: /\.tsbuildinfo$/, why: 'incremental build state', everywhere: true },
  { pattern: /\.DS_Store$/, why: 'a Finder artefact', everywhere: true },
  { pattern: /(^|\/)node_modules\//, why: 'installed dependencies', everywhere: true },
  { pattern: /^package\/src\//, why: 'source; the tarball ships dist' },
  { pattern: /^package\/test\//, why: 'tests' },
  { pattern: /^package\/fixtures\//, why: 'fixtures' },
  { pattern: /tsconfig.*\.json$/, why: 'a build configuration' },
  { pattern: /^package\/\.weft\//, why: 'a build directory' },
]

/** Where the README's version table is written. Both markers must exist, and must be on their own lines. */
export const README_MARKERS = {
  start: '<!-- versions:start -->',
  end: '<!-- versions:end -->',
}

/**
 * The gates a release runs before it writes anything.
 *
 * `build` comes before `typecheck` and `test`, and the order is load-bearing rather than tidy. A
 * package's `exports` point at `dist`, so a program that imports `@weftjs/adapters` is checked
 * against that package's built declarations — not its sources. Typechecking first therefore checks
 * against whatever `dist` was last written, which is stale on any checkout that has not built since
 * the code changed, and wrong in both directions: it fails for reasons that are not in the diff, and
 * it passes on types that are no longer the ones being shipped.
 */
export const GATES = [
  { script: 'format:check', why: 'formatting' },
  { script: 'lint', why: 'lint' },
  { script: 'build', why: 'the build every tarball ships, and the declarations the rest checks against' },
  { script: 'typecheck', why: 'types' },
  { script: 'test', why: 'the test suite and its gates' },
]

/** The branch a release may be cut from. */
export const RELEASE_BRANCH = 'main'

/**
 * The package whose version is the repository's, and therefore the tag's.
 *
 * `@weftjs/core` rather than `weft` because npm already serves a `weft` belonging to somebody else.
 * The command is still `weft`, so is the directory, and so is the commit scope — this is the one
 * spelling that is a package name.
 */
export const FRAMEWORK_PACKAGE = '@weftjs/core'
