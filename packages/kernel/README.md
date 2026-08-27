# @weft/kernel

The request kernel: a two-phase envelope, streaming, cache keys, intents, channels and ports.

Part of [weft](https://github.com/raminjafary/weft), a TypeScript fullstack framework that
negotiates the wire form of a piece of UI per request. Applications import `@weft/core`, which drives this.

```sh
npm install @weft/kernel
```

## What it is

**A request is a state machine** — `received → envelope → planned → streaming → settled`. The
streaming phase is a _different context type_ with no envelope methods on it, so the mistake every
other framework documents cannot be written here. `Cache-Control` and `Vary` are written before the
seal, from the resolved keys, and 103 Early Hints goes out with the envelope still open.

**Render is a DAG.** `needs` is data dependency only: nine slots, three waves, a 42.7 ms critical
path against a 123.3 ms sequential walk — safe for exactly one reason, which is that render is
provably read-only.

**A slot is a hole the shell refuses to wait for.** Out-of-order streaming puts a fast region on
screen 4.7× earlier than in-order in all three engines, for 329 bytes of inline script.

**Intents are the only thing allowed to write**, and they declare what they invalidate. An
undeclared tag throws, because an undeclared write is an invalidation nobody can predict from the
code.

It imports nothing but the WinterTC Minimum Common Web API. That rule has a test, and the test
failed on its first run.

## Reference

[`spec/kernel/`](https://github.com/raminjafary/weft/tree/main/spec/kernel) — lifecycle, routing,
streaming, cache, static, surgical, locus, authority, composition, intents, ports, transport,
budgets.

## License

MIT
