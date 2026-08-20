# Contributing

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org), the Angular flavour, checked
by commitlint in a `commit-msg` hook. Run `pnpm install` once and the hook installs
itself; `pnpm commitlint` checks a branch after the fact.

```
type(scope): subject in the imperative, under 72 characters

Why the change exists and what it costs, wrapped at 100 columns. A measurement
belongs here with its numbers, not in a comment nobody reads again.

BREAKING CHANGE: what stops working, for anyone reading a changelog later.
```

**Types.** `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`,
`revert`.

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

## Before pushing

```sh
pnpm run typecheck                                   # TypeScript, zero errors
node --test packages/*/test/*.test.ts                # unit and conformance tests
node packages/bench/src/cli.ts verify                # every wire form agrees, byte for byte
node packages/bench/src/cli.ts client                # the runtime adopts and patches correctly
node packages/bench/src/cli.ts budget                # nothing has outgrown its byte budget
```

The first three are cheap. The last two need Playwright browsers
(`npx playwright install chromium firefox webkit`) and are the ones that catch the
interesting failures.

## Changelog

`pnpm changelog` regenerates `CHANGELOG.md` from the history. It is generated, never
edited: if an entry reads badly, the commit message was the problem.
