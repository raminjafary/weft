# Devices, engines, and what the harness can prove

The target is every surface at once: desktop browsers, mobile browsers, embedded
webviews, and old devices. Nothing in this design fails on an old engine — every missing
capability costs a wire form, a fill mechanism, or an animation.

## Engines

| Surface              | Engine                           | Notes                                                                        |
| -------------------- | -------------------------------- | ---------------------------------------------------------------------------- |
| Desktop Chrome, Edge | Chromium                         | Everything available, including the Chromium-only bonuses                    |
| Desktop Safari       | WebKit                           | No compression dictionaries, no Speculation Rules                            |
| Desktop Firefox      | Gecko                            | No cross-document View Transitions in stable yet                             |
| Electron             | Recent Chromium                  | Behaves like Chrome                                                          |
| Android WebView      | Chromium, updated via Play Store | Old and AOSP devices lag the desktop version                                 |
| iOS, every webview   | WebKit, by policy                | Incremental DSD parsing is likely the _filler-script_ path, not the fallback |
| Tauri on Linux       | WebKitGTK                        | The genuine laggard                                                          |

## Capability floor

| Capability                                  | Status                                      | Without it                                                       |
| ------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------- |
| HTTP response streaming                     | Universal                                   | —                                                                |
| Web Streams `getReader()`                   | Baseline                                    | —                                                                |
| WebSocket, EventSource                      | Baseline everywhere, webviews included      | Both Warp bindings work                                          |
| Declarative Shadow DOM                      | iOS 16.4+, WebView 111+                     | Holes fill via the ~1 KB filler script                           |
| Same-document View Transitions              | iOS 18, WebView 111+                        | `COMMIT` is an instant swap; epochs lose polish, not correctness |
| `requestIdleCallback`                       | Flag-gated in WKWebView                     | `when.idle` lands on the timeout rung of its ladder              |
| Service workers                             | Gated behind app-bound domains in WKWebView | Resident templates go to IndexedDB, then the HTTP cache          |
| Compression dictionaries, Speculation Rules | Chromium only                               | Pure bonus; the `delta` form already cuts semantic redundancy    |

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

One of these has since been answered for desktop builds: incremental declarative shadow DOM
works in Chromium, Firefox and WebKit — see
[the streaming spec](../kernel/streaming.md). That removes the desktop half of the risk and
none of the device half.

Three things need real devices:

1. Whether incremental DSD parsing works on a given iOS version, on a device.
2. What a host app's request interception does to first-byte timing.
3. How often a backgrounded webview is evicted, and what `RESUME` recovers in practice.

The harness covers what it can: the buffered-transport mode reproduces the _shape_ of an
intercepted request, per-engine numbers are never aggregated, and the storage tier that
the repeat-visit axis depends on is stated with the result.

## The device lane

`--engines ios` and `--engines android` are real engine names, and they refuse by name until
`--devices` points at hardware. What was missing was not only the hardware: there was no way to
point the harness at a device even if you had one. There is now, and it is config.

```sh
node packages/bench/src/cli.ts devices --devices devices.json
```

`devices.json` is an array of descriptors, one per engine name — two devices claiming `ios` is
refused, because a number aggregated over two phones is not a number about either.

| Field          | Meaning                                                                              |
| -------------- | ------------------------------------------------------------------------------------ |
| `id`, `label`  | Printed with every result. An unlabelled device is refused: the label _is_ the claim |
| `engine`       | Which `--engines` name this device answers to: `ios` or `android`                    |
| `transport`    | `cdp` or `webdriver`                                                                 |
| `endpoint`     | Where the driver listens                                                             |
| `capabilities` | W3C capabilities, merged into `alwaysMatch`. WebDriver only                          |
| `context`      | The Appium context to switch into, typically `WEBVIEW_1`. WebDriver only             |
| `reachHost`    | The host the _device_ uses to reach this machine. Absent means loopback              |

Two transports, because the platforms differ:

- **`cdp`** — Android WebView, and remote Chrome. `adb forward tcp:9222
localabstract:webview_devtools_remote_<pid>` exposes the DevTools socket, and Playwright's
  `connectOverCDP` drives it with the full API. Every axis works unchanged.
- **`webdriver`** — WKWebView on iOS, through Appium and the XCUITest driver. There is no CDP on
  that platform and Playwright cannot reach it, so this is a plain W3C client: navigate, evaluate,
  wait, click, hover. It has no event stream, because the protocol has none.

That last sentence is a gate rather than a footnote. The navigation axis tells a staged click from
one handed back to the browser by counting documents, and the channel axis reports page errors as
checks — neither is observable over W3C WebDriver, so both refuse with `E_LANE_CANNOT` on a
webdriver lane instead of reporting a number with a hole in it. A W3C session is also the only
isolation the protocol offers, so a fresh context on that lane is a fresh app launch: an axis that
opens a context per iteration is slow there, which is information about the lane.

A driver that is not there is `E_DEVICE_UNREACHABLE`, naming the endpoint and, for the CDP lane, the
`adb forward` that is usually missing. A raw connect error reads as a broken harness rather than a
driver that is down, and the whole argument for these refusals is that a missing thing should say
what is missing.

Every measurement here serves on this machine's loopback and then tells a browser to go there. On a
phone, loopback is the phone. So the lane needs a reverse tunnel — `adb reverse tcp:P tcp:P` for
Android, an SSH reverse tunnel or the emulator's `10.0.2.2` alias otherwise — and `reachHost` is
where that is declared. The `devices` command prints what each lane assumes, and probes the driver,
so a misconfiguration fails as `DOWN` before a measurement starts rather than as a connection
refused inside one.

What the lane does not do is make a claim. A device engine's row in the proxy table stands for
itself and nothing else: `ios` is the one phone it was pointed at, named in the report, and not a
statement about iOS. The three questions above become answerable on a device; they do not become
answered by the existence of the lane.
