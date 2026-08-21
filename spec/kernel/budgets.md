# Byte budgets, and what each number covers

The design states one server-side figure — "target under 8 KB" — and the kernel it describes
does more than one job. A single number over several jobs is a number you can satisfy by
moving its boundary, which makes it a label rather than a gate. So the ceilings here are
**per entry**, each entry is a real module that a deployment can import on its own, and each
one says what it covers and where its figure comes from.

The measurement is in [`packages/bench/src/budget.ts`](../../packages/bench/src/budget.ts) and
the gate is the test that calls it. Rolldown, minified, brotli at quality 11 — what ships.

## The entries

| Entry              | Covers                                                                             | Ceiling  | Where the ceiling comes from                             |
| ------------------ | ---------------------------------------------------------------------------------- | -------- | -------------------------------------------------------- |
| `entry-request.ts` | Lifecycle, two-phase envelope, routing, key derivation, wave dispatch, the stream  | 8,192 B  | The design's "target under 8 KB server-side"             |
| `entry-channel.ts` | The above, plus surgical refresh, form selection, staged epochs, push invalidation | 12,288 B | No design figure. Measured so a regression is visible    |
| `index.ts`         | Everything, including build-time validation and serialisation                      | —        | Not a claim. Reported so the marginal split is checkable |

**The 8 KB is the document request path.** That is the scoping decision, and it is a
narrowing of what the sentence in the design could be read to mean. The argument for it is
the same argument the design makes for the number in the first place: a deployment that
serves documents and nothing else should not carry the channel path, and measuring it as
though it did is how a budget stops describing anything.

**A new capability gets its own entry and its own stated ceiling**, rather than being pushed
into an existing one. The alternative — one pool everything draws from — means the first
feature to arrive spends the headroom and every later one argues about it.

## What may enter the request path

Two kinds of module are excluded by name, and the exclusion is a reachability gate in
[`standards.test.ts`](../../packages/kernel/test/standards.test.ts) rather than a convention:

- **Build-time work.** `plugin-graph.ts` resolves plugin ordering from static `reads` and
  `provides` declarations. There is no request involved, so `resolvePlugins` runs once and
  `createKernel` takes the schedule it produced.
- **Dev-time checks.** `plugin-guard.ts` enforces declared reads. The design specifies this
  check as one that throws in dev; a production request should not build a nine-method proxy
  per plugin to catch a mistake that fails on the first dev run. It is wired explicitly —
  `createKernel({ guard: guardReads })`.

Reachability rather than a grep, because a module three imports deep is in the request path
exactly as much as one imported directly.

## What is deliberately still in the request path

`schedule()` is pulled in transitively by `dispatch()`. Precomputing waves at lowering time
would save bytes, and it is not being done: the design says the plan is data specifically so
`SchedulerPort` can reorder slots at runtime to fill the pipe fastest-first. Freezing the
waves at build time gives that up. It is the one candidate where a byte saving costs a
declared design property, and it should not be given up by accident.

## The line-count check is not this

`standards.test.ts` also caps the kernel's source lines. That is a smell detector for the
kernel absorbing port-shaped work, not the budget — and it has moved once, when routing was
added, which is worth being uncomfortable about. The byte budgets above are the claim.
