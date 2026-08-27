# @weftjs/plan

The plan layer: a declaration of placement, validated against what the compiler inferred.

Part of [weft](https://github.com/raminjafary/weft), a TypeScript fullstack framework that
negotiates the wire form of a piece of UI per request. `weft build` generates a plan from the file
tree; this is the language it is generated into.

```sh
npm install @weftjs/plan
```

## What it is

A plan says where each fragment goes, which slots stream, what a route caches and how long, what it
composes from elsewhere, and what it is allowed to spend. It is **validated against the effect sets
the compiler inferred**, so a declaration that disagrees with the code is a build failure rather
than a surprise in production.

`weft why <route>` prints the plan the framework generated for a route and where each fact came
from — the file tree, an inference, a declaration, or a recording.

**A plan can come from a measurement, for the half that is about time.** `weft dev --profile`
records what every render costs and the next generation plans delivery from it: a slow region
streams, a uniformly fast page buffers so the 329-byte filler stays off the wire, and a slot with
fewer than eight renders decides nothing. Placement, cache classes and keys are untouched — a
recording of last Tuesday has no standing over what the compiler inferred.

**Plugins extend, ports replace.** A plugin may add a cache axis. It may never write a key.

## Reference

- [`spec/plan/plan.md`](https://github.com/raminjafary/weft/blob/main/spec/plan/plan.md)
- [`spec/plan/profile.md`](https://github.com/raminjafary/weft/blob/main/spec/plan/profile.md)

## License

MIT
