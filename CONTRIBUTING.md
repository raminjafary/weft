# Contributing

- [What you need](#what-you-need)
- [Get it running](#get-it-running)
- [The packages](#the-packages)
- [Running the tests](#running-the-tests)
- [The benchmark harness](#the-benchmark-harness)
- [Developing a feature](#developing-a-feature)
- [Conventions](#conventions)
- [Before pushing](#before-pushing)

## What you need

|                     |                                                                              |
| ------------------- | ---------------------------------------------------------------------------- |
| Node                | `>=22.18.0` — type stripping and `node --test` are both used unflagged       |
| pnpm                | `>=10.16.0`; the repository pins `pnpm@11.22.0` through `packageManager`     |
| Playwright browsers | only for the browser lanes: `npx playwright install chromium firefox webkit` |

Nothing else. The whole framework has one third-party runtime dependency — `oxc-parser`, in the
compiler.

## Get it running

```sh
pnpm install        # also installs the Husky hooks
pnpm build          # ten packages, in dependency order
```

`pnpm build` runs `tsc` per package in the order stated in `scripts/build-packages.mjs`, because a
package's exports map points at its declarations and a dependent cannot typecheck against a `.d.ts`
that does not exist yet. Build one on its own by naming it:

```sh
pnpm build kernel
```

It stops at the first failure — everything after it would fail against missing declarations and bury
the one error that matters — and then checks that nothing was emitted beside a source file.

### The three applications

All three are weft applications, which is the point: the framework is exercised by using it.

```sh
pnpm demo         # six shapes of page                 :4173
pnpm inspect      # a station per capability, running  :4180
pnpm docs:dev     # the documentation site             :4190
```

|                      | What it is                                                          | What to change it for                              |
| -------------------- | ------------------------------------------------------------------- | -------------------------------------------------- |
| `demo/`              | An ordinary application. Imports `weft` and nothing else            | Checking that a feature is usable from the outside |
| `packages/inspector` | Reaches into the kernel, the plan layer and the adapters on purpose | Making a mechanism visible and turnable            |
| `packages/docs`      | The documentation site, generated from the source where it can be   | Writing the paragraph a reader will find           |

Each has `:build` and `:start` variants — `pnpm demo:build`, `pnpm inspect:start`, `pnpm docs:build`
— which run the real build and serve it with no compiler in the process. Use them when a change
could behave differently under `weft start` than under `weft dev`, which is most changes to
placement, caching or assets.

`weft dev --devtools` on any of them adds that application's routes, effect sets, keys and bytes as
pages you can open.

## The packages

Dependency order, which is also roughly the order a request travels through them:

| Package          | What it owns                                                                      |
| ---------------- | --------------------------------------------------------------------------------- |
| `@weft/ir`       | The template IR: what a compiled fragment is                                      |
| `@weft/warp`     | The frame vocabulary that carries it                                              |
| `@weft/client`   | Adoption, signals, deltas, patches, navigation                                    |
| `@weft/compiler` | TSX to IR, on Oxc, with effect inference and the escape class                     |
| `@weft/kernel`   | Routing, lifecycle, cache keys, waves, epochs, surgical refresh, composition      |
| `@weft/plan`     | The plan DSL, validation against inferred effects, plugins, `weft why`            |
| `@weft/adapters` | The fourteen ports, implemented                                                   |
| `weft`           | The CLI, the conventions, the scaffold templates, and what an application imports |
| `@weft/bench`    | The measurement harness and the gates it enforces                                 |
| `create-weft`    | A shim over the templates that ship inside `weft`                                 |

`@weft/docs` and `@weft/inspector` are private and are not built by `pnpm build`; they run from
source through `weft dev`.

**The kernel imports nothing but the WinterTC Minimum Common Web API.** There is a test for it, and
it has caught a real `node:http` import. Anything platform-specific belongs in `@weft/adapters` or
behind a port.

**The scaffold templates live in `@weft/core`, not in `create-weft`.** `packages/weft/templates/{app,minimal}`
is what `npm create weft` writes; `create-weft` only parses argv and calls `scaffold()`. A scaffold
that shipped its own copy of the templates would generate an application the framework has stopped
supporting. Changing a template means running the result:

```sh
node packages/weft/src/cli.ts create /tmp/scratch-app --template app
```

## Running the tests

Tests are `node --test` with no framework, and they live in `test/` beside the package they cover —
76 files in all.

```sh
pnpm test           # every package, plus demo/. The whole suite
pnpm typecheck      # tsc over the workspace, zero errors
pnpm lint           # oxlint, zero errors
```

One file, or one test, while you work:

```sh
node --test packages/kernel/test/streaming.test.ts
node --test --test-name-pattern 'out of order' packages/kernel/test/streaming.test.ts
```

Some suites drive a real browser through Playwright and are the ones that catch the interesting
failures. They are not part of `pnpm test`; they are lanes of the benchmark harness, below.

## The benchmark harness

`weft-bench` is the measurement harness, and several of its lanes are gates rather than reports.
Run it from source:

```sh
node packages/bench/src/cli.ts <command>
```

| Lane      | What it checks                                                                     | Needs a browser     |
| --------- | ---------------------------------------------------------------------------------- | ------------------- |
| `verify`  | Every wire form of a fragment produces identical bytes                             | no                  |
| `budget`  | Every entry against its stated ceiling                                             | no                  |
| `deltas`  | Shared against per-connection delta computation                                    | no                  |
| `list`    | The axes, scenarios and candidates that exist                                      | no                  |
| `ir`      | The sealed, versioned IR for a scenario                                            | no                  |
| `client`  | The runtime adopts, binds and patches correctly in every engine                    | yes                 |
| `slots`   | Both stream orders, and the incremental shadow-DOM probe                           | yes                 |
| `channel` | Which binding a browser really opens, and what happens when the upgrade is refused | yes                 |
| `nav`     | A staged click against the same click handed to the browser                        | yes                 |
| `l0`      | A document served from the build against the same document rendered                | no                  |
| `decode`  | Frames decoded on the main thread against the same frames in a worker              | yes                 |
| `run`     | The axes, and a report                                                             | depends on the axis |
| `devices` | Which devices `--devices` names, and whether each driver answers                   | hardware            |

```sh
node packages/bench/src/cli.ts run --axes shell-ttfb --scenarios slow-feed \
  --latency 40 --bandwidth 1600 --external benchmarks/rr7/candidates.json
```

`--latency` puts a round trip in front of loopback; `--bandwidth` and `--loss` put a rate and a hole
in it, so a byte difference costs time rather than nothing. Any TTFB claim needs `--latency`; any
bytes-on-the-wire claim needs `--bandwidth`. Third-party candidates are configured through
`--external` and never vendored.

**The harness refuses rather than flatters.** It aborts if two wire forms of the same scenario
disagree by a byte, refuses any claim whose p50 ± MAD overlaps, never aggregates engines, labels
`webkit` a desktop proxy rather than an iOS number, and says "not measured" with a reason instead of
reporting a zero. If you are adding an axis, it has to state its expectation up front — including
where the honest expectation is a tie.

## Developing a feature

The repository is built so that shipping a mechanism and describing it are the same change. That is
enforced, so the order below is not advice — steps 5 and 6 are tests that will fail.

**1. Start in `spec/`.** Every capability has a document: the mechanism, its refusals, and a "What
this does not do" section that is the per-capability ledger. Write or amend it first; it is where
the argument gets made, and reviewing prose is cheaper than reviewing an implementation of the wrong
idea.

**2. If a wire format moves, say so.** The template IR and the Warp frame vocabulary are versioned
specifications with a contract in [`spec/VERSIONING.md`](spec/VERSIONING.md): a minor for anything
additive and it must round-trip, a major for a wire break and it must refuse rather than migrate.
Bump the constant, update the spec, and put `BREAKING CHANGE:` in the commit footer if a reader has
to refuse an older document. A test asserts the spec and the constants agree.

**3. Implement it in the package that owns it.** If the kernel needs something from the platform, it
goes behind a port — declared in [`spec/kernel/ports.md`](spec/kernel/ports.md), implemented in
`@weft/adapters`, and refusing by name when it is not bound. A port that approximates is worse than
one that refuses; a store on an edge KV namespace refuses `lease` outright for exactly that reason.

**4. Test it where it lives**, and prefer a test that would have caught the bug over one that
restates the code. Refusals are worth testing by their code — `E_BRANCH_ON_SIGNAL`, not "throws".

**5. Documentation is a gate, in four directions.** `node --test packages/docs/test/docs.test.ts`:

- Every spec document must be introduced by a guide page, and every spec document a page names must
  exist. There is no exemption list.
- Every runtime export of every package must appear in the API reference **and carry a doc comment
  on its declaration**. All 1,367 of them do, asserted as equality rather than a floor.
- Every named refusal in any `src/` must be in the error reference, and must say something other
  than its own name — either its own sentence or a forwarded cause. All 326 of them do.
- Every command the CLI implements must be on the CLI page, which is the `--help` text, parsed.

Adding an export, a refusal or a CLI command without the prose is a failing test, not a follow-up.

**6. Give it a station.** `node --test packages/inspector/test/stations.test.ts` fails when a spec
document has no station claiming it, when a station claims a document that does not exist, and when
a station marked live has no handler. The inspector's promise is that it is not a subset.

**7. Watch the budgets.** `node packages/bench/src/cli.ts budget` bundles fifteen entries and fails
the moment one crosses its ceiling. Ceilings live in `packages/bench/src/budget.ts` with the reason
for each next to it. Raising one is a decision that belongs in
[`spec/kernel/budgets.md`](spec/kernel/budgets.md) with the watermark it moved from — not a quiet
edit. Client-side, `budget({ js, grow })` in the plan is enforced by `weft build`, which writes
`weft.budget.json` so a regression shows up as a diff.

**8. Measure anything you claimed.** If the change was made for speed or for bytes, the number goes
in the commit body, and if it reverses an earlier claim it goes in
[`spec/FINDINGS.md`](spec/FINDINGS.md) with both figures. Five claims in this repository have been
reversed that way; none of them was quietly edited.

## Conventions

### Commit messages

[Conventional Commits](https://www.conventionalcommits.org), the Angular flavour, checked by
commitlint in a Husky `commit-msg` hook. `pnpm install` installs the hooks. `pnpm commit` opens the
Commitizen prompt if you would rather be asked than remember, and `pnpm commitlint` checks a branch
after the fact.

```
type(scope): subject in the imperative, under 72 characters

Why the change exists and what it costs, wrapped at 100 columns. A measurement
belongs here with its numbers, not in a comment nobody reads again.

BREAKING CHANGE: what stops working, for anyone reading a changelog later.
```

**Types.** `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `style`,
`security`, `revert`. Every one of them appears in the changelog — the default preset hides most,
which produces a changelog reading as though nothing but features ever happened, and here a docs or
test commit is frequently the substantive one.

**Scopes**, closed on purpose — a commit that fits none of these is usually a commit doing two
things: `ir`, `warp`, `compiler`, `client`, `kernel`, `bench`, `spec`, `deps`, `repo`.

#### Two conventions specific to this repository

**A measurement that changes a conclusion is a `fix`, not a `docs`.** This project's output is partly
its findings, and a number that reverses an earlier claim is a defect being corrected. Put the old
figure and the new one in the body.

**A format change states its version consequence.** A commit touching the template IR or the Warp
frame vocabulary says which component moved and why. The rules are in
[`spec/VERSIONING.md`](spec/VERSIONING.md).

### Code

Comments explain why, not what. The ones already in this repository are worth reading as the house
style: they carry the argument, the measurement, or the mistake that was made once — several of them
name a bug that shipped and the test that now prevents it. A comment restating the line under it is
noise; a comment saying which failure a line prevents is the reason the line survives review.

Refusals are named and say why. `E_*` codes are part of the public surface, they are tested by code,
and they appear in the error reference automatically — a refusal whose message is only its own name
fails that test.

### Linting and formatting

`pnpm lint` is [oxlint](https://oxc.rs); `pnpm format` is Prettier. They cannot disagree, because
oxlint is configured for correctness only and every question of layout is Prettier's. Both run on
staged files through lint-staged in a `pre-commit` hook.

**Not eslint, and not by preference.** `typescript-eslint` refuses to load against TypeScript 7 —
_"typescript-eslint does not support TS 7.0"_, thrown from the package itself — so linting
TypeScript with eslint would mean pinning a second, older TypeScript purely for the linter. oxlint
needs no TypeScript at all, and it is the linter the design already names in its toolchain.

Three of oxlint's rules are switched off in `.oxlintrc.json` with the reason next to each, which is
the only acceptable way to switch a rule off. `no-await-in-loop` fires 46 times on deliberately
sequential code: a measurement that runs concurrently contends for the same CPU, and a stream has to
be written in order. `unicorn/no-array-sort` wants `toSorted()`, which is ES2023 — the client
runtime targets old webviews, and `[...x].sort()` is already non-mutating.
`unicorn/prefer-add-event-listener` fires on every IndexedDB request, whose `on*` handlers are the
API's own idiom.

### Dependencies

Every version is exact — `save-exact=true`, and no ranges in any `package.json`. A range is a
decision deferred to whoever installs next.

Nothing younger than a day is installed: `minimumReleaseAge: 1440` in `pnpm-workspace.yaml`,
mirrored by `minimumReleaseAge: "1 day"` in `renovate.json`. A compromised or broken publish then has
a window in which to be found before it reaches this repository. Five packages wait a week instead,
because they decide what the harness measures or whether it builds at all: `typescript`,
`oxc-parser`, `rolldown`, `oxlint` and `playwright`.

Adding a runtime dependency is a design decision, not a convenience one. There is currently one.

### Releasing

Releases are cut from `main`, from a laptop. There is no CI, so `scripts/release/` does the checking
that a pipeline would: it refuses to write anything until formatting, lint, types, the build and 928
tests have passed, every tarball has been packed and inspected, and every name has been confirmed
publishable by the account that is logged in.

```sh
pnpm release:dry     # everything below, writing nothing and publishing nothing
pnpm release         # do it
pnpm release:undo v0.1.0    # take one back
pnpm changelog       # regenerate every changelog from the git history
pnpm pack:audit      # pack each published package and list what came out
```

#### What a release does, in order

1. **Preflight.** On `main`, clean tree, in sync with `origin/main`, logged in to npm, a GitHub token
   that can write releases. In a dry run these are reported and the run continues; in a real one the
   first failure stops it, before anything has been written.
2. **Work out the versions.** Every commit since the last `v*` tag is parsed, and its scopes are
   resolved to packages through `scripts/release/config.mjs`. A `feat` is a minor bump, a breaking
   change is a minor bump too while the major is 0, and everything else is a patch — a `docs` commit
   included, because a doc comment ships inside a published `.d.ts`.
3. **Propagate.** Every package that depends on a bumped one is bumped as well. This is not tidiness:
   pnpm rewrites `workspace:*` to an exact version when it packs, so a dependent left behind would
   publish a manifest pinning a dependency it was never tested against — or fail outright, having
   already published that version number once.
4. **Gates.** `format:check`, `lint`, `typecheck`, `build`, `test`. Build before test, because the
   tests typecheck against built declarations.
5. **Audit the tarballs.** Each published package is packed for real and every entry checked against
   an allowlist. `files` fails silently in the direction that matters — an entry matching nothing is
   not an error — so this catches a rename that quietly drops `dist`, and it also verifies that every
   `exports`, `bin`, `main` and `types` target is actually inside the tarball.
6. **Check the names.** That the account logged in can publish each name at the version planned.
   Asked here, last, because it is the one answer that cannot be recovered from mid-release.
7. **Write.** Versions into the manifests, `CHANGELOG.md` at the root and one per package, and the
   version table in `README.md`.
8. **Commit and tag.** `chore(release): v0.1.0`, and an annotated tag carrying the changelog entry.
9. **Push, then publish.** In that order, deliberately. A push that lands with the registry not yet
   updated is fixed by publishing again; a publish that lands with the push lost has burned version
   numbers npm will never accept a second time.
10. **Announce.** A GitHub release for the tag, with the changelog entry and the list of what went to
    npm. Pushing `main` is also what deploys the documentation site — Vercel builds from the push, so
    there is no separate deploy step.

`--publish-only` finishes a release that got as far as the push and then failed: it skips versioning
and publishes the current manifests, skipping anything already on the registry.

#### What is published, and what is not

Nine packages: `weft`, `create-weft`, and the seven `@weft/*` that `weft` depends on. `@weft/bench`,
`@weft/docs` and `@weft/inspector` are `private` — nothing an application installs needs the
measurement harness, the documentation site or the inspector.

A tarball holds `dist`, the README, the changelog, the licence, and for `weft` its `bin` and
`templates`. It holds no `src` and no source maps: an application needs the built framework, not the
framework's sources. That is why `tsconfig.base.json` turns both map options off, and why the pack
audit rejects a `.map` anywhere.

The version table in `README.md` sits between `<!-- versions:start -->` and `<!-- versions:end -->`
and is written by the release. The descriptions in it live in `scripts/release/lib/readme.mjs`, which
is also where a new package has to be listed — the release fails if it finds one it does not know.

#### Changelogs

Every `CHANGELOG.md` is generated from the git history, and regenerated whole rather than appended
to. That is the point: the history is the single source of truth, so a changelog that has drifted
from it is repaired by running `pnpm changelog` rather than by hand. The root file holds every
commit; a package file holds the commits scoped to that package, plus a line naming the dependency
when a version moved only because something below it did.

`pnpm changelog --check` writes nothing and fails if any file is out of date.

A changelog is never edited: if an entry reads badly, the commit message was the problem. One quirk
of the parser is worth knowing — a body line beginning with a word and a colon is read as a git
trailer, and commitlint then warns that a footer needs a blank line before it. Start the sentence
differently, or accept the warning.

The twelve commits before `build(repo): enforce conventional commits` carry no type, so nothing can
classify them. They appear under **Foundations**, with a note saying why, rather than being dropped —
0.1.0 contains them.

#### Undoing one

```sh
pnpm release:undo v0.1.0          # prints a plan and stops
pnpm release:undo v0.1.0 --yes    # unpublish, delete the GitHub release, drop the tag, revert
```

It reads what that release published out of the tagged tree rather than out of the current
manifests, so it works after the tree has moved on. `--deprecate` is the fallback once npm's
72-hour unpublish window has closed: the versions stay and installing one warns.

One thing it cannot undo. npm never lets a version number be published twice, even after an
unpublish — once `weft@0.1.0` has existed, that number is gone and the fix has to be a new one. This
is a repair for a bad publish, not an alternative to `pnpm release:dry`.

#### The GitHub token

`GITHUB_TOKEN` (or `GH_TOKEN`) in the environment, with write access to the repository's contents.
The release checks it can push to this repository before it writes anything, and `--no-github` skips
the step. `gh` is not required; the release talks to the REST API directly.

## Before pushing

```sh
pnpm typecheck                                       # TypeScript, zero errors
pnpm lint                                            # oxlint, zero errors
pnpm test                                            # unit and conformance tests
node packages/bench/src/cli.ts verify                # every wire form agrees, byte for byte
node packages/bench/src/cli.ts budget                # nothing has outgrown its byte budget
node packages/bench/src/cli.ts client                # the runtime adopts and patches correctly
node packages/bench/src/cli.ts slots                 # both stream orders, and the DSD probe
```

The first three are cheap. The last two need Playwright browsers
(`npx playwright install chromium firefox webkit`) and are the ones that catch the interesting
failures.
