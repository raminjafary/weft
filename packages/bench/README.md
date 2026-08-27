# @weft/bench

The measurement harness. Every number in weft's specs is something this produced.

Part of [weft](https://github.com/raminjafary/weft), a TypeScript fullstack framework that
negotiates the wire form of a piece of UI per request.

```sh
npm install -D @weft/bench
weft-bench list
```

## What it is

Half report, half gate. `verify` fails if two wire forms of the same fragment differ by a byte;
`budget` fails the moment an entry crosses its ceiling; `client`, `slots` and `channel` run the
runtime's conformance checks in Chromium, Firefox and WebKit.

```sh
weft-bench verify                    # every wire form agrees, byte for byte
weft-bench budget                    # every entry against its stated ceiling
weft-bench client --engines chromium,firefox,webkit
weft-bench run --axes shell-ttfb --latency 40 --bandwidth 1600
```

## What it refuses to do

- **It aborts if the wire forms disagree** — including each candidate's response as served over
  HTTP, because a streaming server assembles its response separately from the in-process renderer.
- **It refuses claims below the noise floor.** Overlapping p50 ± MAD is "not separable at this
  sample size — no claim".
- **It never aggregates engines**, and labels `webkit` a desktop proxy rather than an iOS number.
- **It says "not measured" with a reason** instead of reporting a zero.
- **It states each axis's expectation up front**, including the one where the honest answer is a tie.

`--latency` puts a round trip in front of loopback; `--bandwidth` and `--loss` put a rate and a hole
in it, so a byte difference costs time rather than nothing. Third-party candidates are configured
through `--external` and never vendored.

## License

MIT
