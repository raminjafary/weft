# @weftjs/ir

The Template IR: sealed, versioned templates, their effects, and the renderer that fills them.

Part of [weft](https://github.com/raminjafary/weft), a TypeScript fullstack framework that
negotiates the wire form of a piece of UI per request. Applications import `@weftjs/core`; this package is
what the compiler writes and what every other layer reads.

```sh
npm install @weftjs/ir
```

## What it is

A compiled fragment is **data**, not a function. That single decision is why rendering a component
ten times adds ten items of content and no template, why a delta can address a hole directly with
nothing to reconcile, and why a template can be shipped once and kept resident on a client across
visits.

The package holds the IR types, the sealing and versioning rules, the effect sets a fragment
carries, and the renderer that turns pre-encoded byte segments into a response — measured at
1.4–1.96× a string-concatenating SSR of the same templates.

## Version

The IR is a versioned specification. A minor is additive and must round-trip; a major is a wire
break and refuses rather than migrates. Both rules are in
[`spec/VERSIONING.md`](https://github.com/raminjafary/weft/blob/main/spec/VERSIONING.md), and the
format itself is in
[`spec/ir/template-ir-2.md`](https://github.com/raminjafary/weft/blob/main/spec/ir/template-ir-2.md).

## License

MIT
