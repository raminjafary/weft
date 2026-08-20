# React Router 7 candidate

The phase-zero gate: _if the pre-encoded-buffer shell does not beat a tuned React
Router 7 app on TTFB in a reproducible test, the central premise is wrong._ This is that
app, and the harness measures it exactly like any other candidate — same scenario, same
injected latency, same statistics, same refusal to claim a difference it cannot resolve.

Two configurations, because the difference between them turns out to matter far more than
the difference between either of them and Weft:

| Mode           | Shape                                                                                                                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rr7-stream`   | The loader returns an unresolved promise. The slow region sits behind a `Suspense` boundary and the response is piped on `onShellReady`, so the shell is not downstream of the query. **This is the tuned configuration.** |
| `rr7-blocking` | The loader is awaited, there is no boundary, and the response is piped on `onAllReady`. This is the shape most applications ship.                                                                                          |

Both use React Router 7's `createStaticHandler` / `createStaticRouter` /
`StaticRouterProvider` with React 19 `renderToPipeableStream`, and both render the same
document as the `slow-feed` scenario — the same rows from the same generator, behind the
same 40 ms query.

## Running it

```sh
pnpm install
node packages/bench/src/cli.ts run --axes shell-ttfb --scenarios slow-feed \
  --latency 40 --external benchmarks/rr7/candidates.json
```

The harness spawns and stops the app itself. `candidates.json` pins `DELAY=40` and
`ROWS=50` to match `slow-feed`; measuring a different scenario means changing both, and
the report prints `queryMs` so a mismatch is visible rather than silent.

## What is fair, and what is not

The apps are not byte-identical to ours and cannot be — React emits Suspense markers and
comment nodes, which is why `rr7-stream` sends 7,687 bytes against our 6,289 for the same
content. The harness's byte-equality gate therefore covers our own candidates only;
third-party candidates are flagged `thirdParty` and excluded from it, and measured on
timing and payload size instead.

Written with `createElement` rather than JSX so it runs on plain Node with no build step,
which keeps the thing being measured a runtime rather than a toolchain.
