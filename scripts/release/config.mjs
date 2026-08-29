/**
 * What a release is, stated once. Written here rather than delegated to a generic tool: pnpm
 * rewrites `workspace:*` to an exact version at pack time, so a scoped commit has to bump its
 * package and everything depending on it, or a dependent ships a range it was never tested against.
 */

/** Every type appears in the changelog, not only feat and fix — a docs or test commit is often the substantive one here. Order is section order. */
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
  // Synthetic: written by the changelog generator, never parsed from a commit.
  { type: 'deps', title: '⬆️ Workspace Dependencies' },
  // The twelve commits predating `build(repo): enforce conventional commits` — the project's first month.
  { type: 'foundations', title: '🌱 Foundations' },
]

/** Bump precedence, low to high. */
export const LEVELS = ['patch', 'minor', 'major']

/** Commit scope to workspace directory. Closed on purpose, mirroring `scope-enum` in commitlint.config.js. */
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

/** What a published tarball may contain. `src` and source maps are deliberately absent — checked against a real tarball in `pack.mjs`. */
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
 * Entries that are never a release, whatever `files` says. `everywhere` distinguishes a rule about
 * this package from a rule about any file — a `tsconfig.json` under `templates/` is scaffold output,
 * not an escaped build config, so forbidding it everywhere would forbid `weft create` itself.
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
 * The gates a release runs before it writes anything. `build` before `typecheck`/`test` is
 * load-bearing, not tidy: `exports` points at `dist`, so typechecking first would check against a
 * stale build — wrong in both directions.
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

/** The package whose version is the repository's, and therefore the tag's. `@weftjs/core`, not `weft` — npm's `weft` belongs to somebody else. */
export const FRAMEWORK_PACKAGE = '@weftjs/core'
