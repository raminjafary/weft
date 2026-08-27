# @weft/compiler

TSX to Template IR, with effect inference and a type-driven escape class.

Part of [weft](https://github.com/raminjafary/weft), a TypeScript fullstack framework that
negotiates the wire form of a piece of UI per request. `weft build` and `weft dev` run this for you.

```sh
npm install @weft/compiler
```

## What it is

A fragment body is a declaration the compiler reads and never runs. That is the line the design will
not move, and it is what makes the rest possible: there is nowhere for a call to happen, so the
client bundle cannot grow with the application.

The compiler parses with [Oxc](https://oxc.rs), seals each fragment into IR, and **infers what it
reads**. The cache class is derived from those reads, which is why there is no setter for a cache
key anywhere in the framework — a key you can hand-write is a key that can disagree with the code.
`.cache('public')` on a fragment that reads identity fails the build with `identity` named.

Refusals are named and explained rather than silent: `E_BRANCH_ON_SIGNAL`,
`E_CHILDREN_NOT_SOLE_CHILD`, `E_COMPONENT_NOT_SINGLE_ROOT` and the rest are each a consequence of
templates being data compiled without seeing their call site.

## Reference

- [`spec/compiler/supported-subset.md`](https://github.com/raminjafary/weft/blob/main/spec/compiler/supported-subset.md)
- [`spec/compiler/effects.md`](https://github.com/raminjafary/weft/blob/main/spec/compiler/effects.md)

## License

MIT
