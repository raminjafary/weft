# Devices, engines, and what the harness can prove

The target is every surface at once: desktop browsers, mobile browsers, embedded
webviews, and old devices. Nothing in this design fails on an old engine — every missing
capability costs a wire form, a fill mechanism, or an animation.

## Engines

| Surface | Engine | Notes |
| --- | --- | --- |
| Desktop Chrome, Edge | Chromium | Everything available, including the Chromium-only bonuses |
| Desktop Safari | WebKit | No compression dictionaries, no Speculation Rules |
| Desktop Firefox | Gecko | No cross-document View Transitions in stable yet |
| Electron | Recent Chromium | Behaves like Chrome |
| Android WebView | Chromium, updated via Play Store | Old and AOSP devices lag the desktop version |
| iOS, every webview | WebKit, by policy | Incremental DSD parsing is likely the *filler-script* path, not the fallback |
| Tauri on Linux | WebKitGTK | The genuine laggard |

## Capability floor

| Capability | Status | Without it |
| --- | --- | --- |
| HTTP response streaming | Universal | — |
| Web Streams `getReader()` | Baseline | — |
| WebSocket, EventSource | Baseline everywhere, webviews included | Both Warp bindings work |
| Declarative Shadow DOM | iOS 16.4+, WebView 111+ | Holes fill via the ~1 KB filler script |
| Same-document View Transitions | iOS 18, WebView 111+ | `COMMIT` is an instant swap; epochs lose polish, not correctness |
| `requestIdleCallback` | Flag-gated in WKWebView | `when.idle` lands on the timeout rung of its ladder |
| Service workers | Gated behind app-bound domains in WKWebView | Resident templates go to IndexedDB, then the HTTP cache |
| Compression dictionaries, Speculation Rules | Chromium only | Pure bonus; the `delta` and `data` forms already cut semantic redundancy |

Because incremental DSD parsing is tracked separately from DSD support, the honest claim
is "zero JavaScript hole filling where incremental parsing works, plus at worst 1 KB
where it does not" — and on iOS that filler script should be assumed to be the primary
path until measured otherwise on a device.

## What the harness can and cannot prove

Playwright's `webkit` is the closest available proxy for an iOS webview and it is **not**
WKWebView on a device: no app-bound-domain rules, no host-app request interception, no
OS-level suspension. Every report labels it as a proxy, and the runner emits a warning
whenever `webkit` is in the engine list. A webkit number is never published as an iOS
number.

Three things need real devices and are therefore out of the harness's reach today:

1. Whether incremental DSD parsing works on a given iOS version.
2. What a host app's request interception does to first-byte timing.
3. How often a backgrounded webview is evicted, and what `RESUME` recovers in practice.

The harness covers what it can: the buffered-transport mode reproduces the *shape* of an
intercepted request, per-engine numbers are never aggregated, and the storage tier that
the repeat-visit axis depends on is stated with the result.
