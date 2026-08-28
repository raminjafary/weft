# Changelog

Every commit in this repository appears here, not only `feat` and `fix`. The sections are
generated from Conventional Commit types by `scripts/release/`, and a package changelog holds
the commits scoped to that package.

## [0.1.1](https://github.com/raminjafary/weft/compare/v0.1.0...HEAD) (2026-08-28)

### ⬆️ Workspace Dependencies

* bumped for `@weftjs/adapters@0.1.1`
* bumped for `@weftjs/compiler@0.1.1`
* bumped for `@weftjs/core@0.1.1`
* bumped for `@weftjs/ir@0.1.1`
* bumped for `@weftjs/kernel@0.1.1`
* bumped for `@weftjs/plan@0.1.1`

## 0.1.0 (2026-08-28)

### ✨ Features

* a link with a rate and a hole in it, and a lane a phone can be plugged into ([a7cc96c](https://github.com/raminjafary/weft/commit/a7cc96c0758b1dca4a3141d901047426e274e06b))
* the two decode paths, and the worker losing to the thread it was meant to spare ([ff7ed7d](https://github.com/raminjafary/weft/commit/ff7ed7d2c45b8ce0c396cc7d1b81c237b1c4b0e2))
* a staged click against the same click handed to the browser ([5557d77](https://github.com/raminjafary/weft/commit/5557d777de697d89d0d6ca3c65ef2c233d4f967a))

### 🐛 Bug Fixes

* the byte budgets were measured into a terminal and nowhere else ([e127c8e](https://github.com/raminjafary/weft/commit/e127c8e187d7e6b9728a81d73ec64ab4936cd4fc))
* an unreachable device keeps the error that said why ([bf34b8f](https://github.com/raminjafary/weft/commit/bf34b8faf75a0b19330f570dfa41fc9fb8da824a))
* a device lane pointed at nothing says so instead of failing to fetch ([c580dfe](https://github.com/raminjafary/weft/commit/c580dfeea8064ebc120c4f72f32aeb0d99694da7))

### ✅ Testing

* gate the kernel's byte budget against the design's 8 KB ([18eee7c](https://github.com/raminjafary/weft/commit/18eee7ca5e3a0db33847349b2c185f2d8d95ac75))
