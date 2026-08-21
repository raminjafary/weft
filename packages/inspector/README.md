# @weft/inspector

The framework inspecting itself. A station per mechanism, and each one is a page you can drive:
change a control, watch the number move, and read what produced it.

```
pnpm inspect
```

## Why it is not in the demo

It used to be. It was the largest thing in `demo/` and the only part that imported
`@weft/kernel`, `@weft/plan`, `@weft/adapters` and `@weft/warp` directly — because taking those
apart is its whole purpose. That is not an application using a framework, and an application is
what a demo is supposed to be. So the demo kept the five showcases and this took the stations.

The distinction is worth holding: **`demo/` may only import `weft`.** If a station needs
something, that is a fact about the framework's internals, not a gap in its front door. If the
_demo_ needs something, the front door is missing it.

## Why it is an application

Every station is a route file under `app/routes/s/`, rendered through the kernel with the same
document. An inspector whose own chrome came from somewhere else would have exempted itself from
what it is inspecting — and if the convention could not express this, that would be worth knowing.

## What is honest about it

`status` in the station registry is checked, not claimed. `live` means the mechanism runs when you
open the page, and a test fails the build if a station says `live` with no handler registered.
`refused` means the capability does not exist: the page says so and links to the roadmap entry
rather than mocking it. And `/spec` fails the build when a spec document has no station pointing at
it, which is what makes "not a subset" a promise rather than a claim.
