# @weftjs/client

The client runtime: signals, adoption, deltas, epochs, template residency and a frame router.

Part of [weft](https://github.com/raminjafary/weft), a TypeScript fullstack framework that
negotiates the wire form of a piece of UI per request. `@weftjs/core` serves this to the browser for you.

```sh
npm install @weftjs/client
```

## What it is

**Nothing mounts.** Adoption walks the DOM the parser already built and records where each value
lives, with no component code executing. On a 50-row region with ~200 bindings that is 0.044–0.105 ms
— faster than parsing the same markup in Chromium and WebKit — and applying a 12-path delta
afterwards costs 0.0018–0.0029 ms, **21–68× cheaper than the parse it replaces**.

**Epochs separate data currency from view currency.** Staged frames paint nothing; one `COMMIT`
flips every slot at once. Prefetch cannot disturb the present, rollback is discarding an epoch, and
it costs 254 bytes.

**Templates stay resident** in IndexedDB across visits — not a service worker, because WKWebView
gates those behind app-bound domains and that is exactly the traffic where a repeat-visit gain
matters. A repeat boot is 0.70 ms against 2.60 in Chromium, with protocol bytes going 1,124 → 132.

The whole runtime is **6,137 bytes brotli**, against a ceiling of 6,144 that a test enforces. An
application can ship no client code at all: adoption, intents and control wiring are reached through
`data-weft-*` attributes.

## Reference

- [`spec/client/adoption.md`](https://github.com/raminjafary/weft/blob/main/spec/client/adoption.md)
- [`spec/client/signals.md`](https://github.com/raminjafary/weft/blob/main/spec/client/signals.md)
- [`spec/client/navigation.md`](https://github.com/raminjafary/weft/blob/main/spec/client/navigation.md)

## License

MIT
