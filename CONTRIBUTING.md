# Contributing

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org), the Angular flavour, checked by
commitlint in a Husky `commit-msg` hook. `pnpm install` installs the hooks. `pnpm commit`
opens the Commitizen prompt if you would rather be asked than remember, and `pnpm commitlint`
checks a branch after the fact.

```
type(scope): subject in the imperative, under 72 characters

Why the change exists and what it costs, wrapped at 100 columns. A measurement
belongs here with its numbers, not in a comment nobody reads again.

BREAKING CHANGE: what stops working, for anyone reading a changelog later.
```

**Types.** `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `style`,
`security`, `revert`. Every one of them appears in the changelog — the default preset hides
most, which produces a changelog reading as though nothing but features ever happened, and
here a docs or test commit is frequently the substantive one.

**Scopes**, closed on purpose — a commit that fits none of these is usually a commit doing
two things: `ir`, `warp`, `compiler`, `client`, `kernel`, `bench`, `spec`, `deps`, `repo`.

### Two conventions specific to this repository

**A measurement that changes a conclusion is a `fix`, not a `docs`.** This project's
output is partly its findings, and a number that reverses an earlier claim is a defect
being corrected. Put the old figure and the new one in the body.

**A format change states its version consequence.** The template IR and the Warp frame
vocabulary are versioned specifications, and a commit touching either says which component
moved and why — a minor for anything additive, a major for a wire break, and
`BREAKING CHANGE:` in the footer when a reader has to refuse an older document. The rules
themselves are in [`spec/VERSIONING.md`](spec/VERSIONING.md).

## Linting and formatting

`pnpm lint` is [oxlint](https://oxc.rs); `pnpm format` is Prettier. They cannot disagree,
because oxlint is configured for correctness only and every question of layout is Prettier's.
Both run on staged files through lint-staged in a `pre-commit` hook.

**Not eslint, and not by preference.** `typescript-eslint` refuses to load against
TypeScript 7 — _"typescript-eslint does not support TS 7.0"_, thrown from the package itself
— so linting TypeScript with eslint would mean pinning a second, older TypeScript purely for
the linter. oxlint needs no TypeScript at all, and it is the linter the design already names
in its toolchain.

Three of oxlint's rules are switched off in `.oxlintrc.json` with the reason next to each,
which is the only acceptable way to switch a rule off. `no-await-in-loop` fires 46 times on
deliberately sequential code: a measurement that runs concurrently contends for the same CPU,
and a stream has to be written in order. `unicorn/no-array-sort` wants `toSorted()`, which is
ES2023 — the client runtime targets old webviews, and `[...x].sort()` is already
non-mutating. `unicorn/prefer-add-event-listener` fires on every IndexedDB request, whose
`on*` handlers are the API's own idiom.

## Dependencies

Every version is exact — `save-exact=true`, and no ranges in any `package.json`. A range is a
decision deferred to whoever installs next.

Nothing younger than a day is installed: `minimumReleaseAge: 1440` in `pnpm-workspace.yaml`,
mirrored by `minimumReleaseAge: "1 day"` in `renovate.json`. A compromised or broken publish
then has a window in which to be found before it reaches this repository. Four packages wait
a week instead, because they decide what the harness measures or whether it builds at all:
`typescript`, `oxc-parser`, `rolldown`, `oxlint`, and `playwright`.

## Releasing

`pnpm release` runs commit-and-tag-version: it bumps, writes `CHANGELOG.md` from the history,
commits and tags. `pnpm changelog` regenerates the changelog alone. Sections and their order
live in `.versionrc.cjs`.

## Before pushing

```sh
pnpm run typecheck                                   # TypeScript, zero errors
pnpm lint                                            # oxlint, zero findings
node --test packages/*/test/*.test.ts                # unit and conformance tests
node packages/bench/src/cli.ts verify                # every wire form agrees, byte for byte
node packages/bench/src/cli.ts client                # the runtime adopts and patches correctly
node packages/bench/src/cli.ts budget                # nothing has outgrown its byte budget
node packages/bench/src/cli.ts slots                 # both stream orders, and the DSD probe
```

The first three are cheap. The rest need Playwright browsers
(`npx playwright install chromium firefox webkit`) and are the ones that catch the
interesting failures.

`CHANGELOG.md` is generated, never edited: if an entry reads badly, the commit message was
the problem. One quirk of the parser worth knowing — a body line beginning with a word and a
colon is read as a git trailer, and commitlint then warns that a footer needs a blank line
before it. Start the sentence differently, or accept the warning.
