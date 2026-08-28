# Changelog

Every commit in this repository appears here, not only `feat` and `fix`. The sections are
generated from Conventional Commit types by `scripts/release/`, and a package changelog holds
the commits scoped to that package.

## [0.3.3](https://github.com/raminjafary/weft/compare/v0.2.3...HEAD) (2026-08-28)

### 🐛 Bug Fixes

* **kernel:** the tab you pressed the button in was the only one not told ([fd7b41b](https://github.com/raminjafary/weft/commit/fd7b41b2ae4e0b0e525f9c8d31b3f17e83cd22c4))
* **client:** staging waited two seconds for an answer that had already arrived ([8207214](https://github.com/raminjafary/weft/commit/82072145de5ae36a7b26a784d050df04498efc93))

## [0.3.2](https://github.com/raminjafary/weft/compare/v0.2.2...v0.2.3) (2026-08-28)

### ⬆️ Workspace Dependencies

* bumped for `@weftjs/adapters@0.1.5`
* bumped for `@weftjs/compiler@0.1.5`
* bumped for `@weftjs/core@0.2.3`
* bumped for `@weftjs/kernel@0.2.3`
* bumped for `@weftjs/plan@0.1.5`

## [0.3.1](https://github.com/raminjafary/weft/compare/v0.2.1...v0.2.2) (2026-08-28)

### ⬆️ Workspace Dependencies

* bumped for `@weftjs/adapters@0.1.4`
* bumped for `@weftjs/compiler@0.1.4`
* bumped for `@weftjs/core@0.2.2`
* bumped for `@weftjs/kernel@0.2.2`
* bumped for `@weftjs/plan@0.1.4`
* bumped for `@weftjs/warp@0.1.1`

## [0.3.0](https://github.com/raminjafary/weft/compare/v0.2.0...v0.2.1) (2026-08-28)

### ✨ Features

* the walk over HTTP is a command, so the cross-check can be re-run ([55d4979](https://github.com/raminjafary/weft/commit/55d4979798aabf47c7c2696e3667318c6dcc8949))

### 🐛 Bug Fixes

* **repo:** the navigation table has both its columns, and the download figure is checkable ([f909a40](https://github.com/raminjafary/weft/commit/f909a404c5961c9a725b7864ac58f0f19b648f09))
* a shaped link cancelled the bytes it had already accepted, so nav never finished ([eec3402](https://github.com/raminjafary/weft/commit/eec34021ee35bb533e85317af833e12d4a1b2061))

## [0.2.0](https://github.com/raminjafary/weft/compare/v0.1.1...v0.2.0) (2026-08-28)

### ✨ Features

* the five commands that measured into a terminal now write it down ([212db33](https://github.com/raminjafary/weft/commit/212db33aa24969d2d5499cbd28d946bf0f954f2b))
* **kernel:** a channel binding that holds nothing, so a host with no process can carry one ([559eb88](https://github.com/raminjafary/weft/commit/559eb88431646d0e37f993ba58157727814d1455))

## [0.1.1](https://github.com/raminjafary/weft/compare/v0.1.0...v0.1.1) (2026-08-28)

### ⬆️ Workspace Dependencies

* bumped for `@weftjs/adapters@0.1.1`
* bumped for `@weftjs/compiler@0.1.1`
* bumped for `@weftjs/core@0.1.1`
* bumped for `@weftjs/ir@0.1.1`
* bumped for `@weftjs/kernel@0.1.1`
* bumped for `@weftjs/plan@0.1.1`

## 0.1.0 (2026-08-28)

### ✨ Features

* **ir, compiler:** a row may interpolate its item, not only its fields ([0c50d13](https://github.com/raminjafary/weft/commit/0c50d1397404d1d2ec92d47373b4e5bd31ce6927))
* **ir, compiler, client:** a hole may hold a conditional value ([7ca9daf](https://github.com/raminjafary/weft/commit/7ca9daff78727ca039ed60f1cea879baa16a04ea))
* **kernel, plan, weft, demo:** a document that is a chain of layouts, checked as one document ([b18573f](https://github.com/raminjafary/weft/commit/b18573f2ba9663f523b0480407c1e5d8e475151e))
* a link with a rate and a hole in it, and a lane a phone can be plugged into ([a7cc96c](https://github.com/raminjafary/weft/commit/a7cc96c0758b1dca4a3141d901047426e274e06b))
* **weft, warp, kernel, adapters:** the socket a channel is for, the downgrades in traffic, and Workers ([7182f5b](https://github.com/raminjafary/weft/commit/7182f5b193a79790e7b35222b43f7e9ccbd46fda))
* **weft, kernel, plan:** four plan declarations that were recorded and read by nothing ([24227f2](https://github.com/raminjafary/weft/commit/24227f2b0aa0a48c68a693111f3555e4cfdc82a4))
* **ir, kernel, client:** the rung the surgical ladder was missing, and what a list taught it ([0d1590a](https://github.com/raminjafary/weft/commit/0d1590a58a6aa827385b11904e855592ba640f31))
* **kernel:** the seams phase seven and nine left open, and the field that was answering two questions ([07f9dd4](https://github.com/raminjafary/weft/commit/07f9dd42edc7b54c20b6a7a50ae91a09d78d621f))
* **plan:** a shell is a plan whose leaves may live somewhere else ([805f795](https://github.com/raminjafary/weft/commit/805f795a9f96fb1f66072c7eb8e60c52370958f7))
* **kernel:** a region is a fragment that lives somewhere else, and the check that lets its frames in ([634497f](https://github.com/raminjafary/weft/commit/634497f5f782a4527b28563b786dc604b4b06ee0))
* **kernel:** who may run an intent, whether this deployment issued it, and a plan a client can ask for ([bdfcbd7](https://github.com/raminjafary/weft/commit/bdfcbd7d0947f03d2bbbc56a77e3ea460cec59c7))
* the two decode paths, and the worker losing to the thread it was meant to spare ([ff7ed7d](https://github.com/raminjafary/weft/commit/ff7ed7d2c45b8ce0c396cc7d1b81c237b1c4b0e2))
* **kernel:** WARM stages a route, NAV answers, and a delta arrives for a page nobody has visited ([5228137](https://github.com/raminjafary/weft/commit/5228137bfeac493ca124ad06556dce88d768d050))
* **weft:** three signals for the readers who cannot hover ([54e7076](https://github.com/raminjafary/weft/commit/54e7076f98c628c9670a392d6f8c90f73860d3d0))
* a staged click against the same click handed to the browser ([5557d77](https://github.com/raminjafary/weft/commit/5557d777de697d89d0d6ca3c65ef2c233d4f967a))
* **compiler:** a component in any shape, and the two refusals that go away ([1073ae5](https://github.com/raminjafary/weft/commit/1073ae561e3baefb4ed1c3602d8dc06bad16c7b3))
* **weft:** a page that reads nothing is a file ([8d89bd2](https://github.com/raminjafary/weft/commit/8d89bd24625ceaa059994f6ce57eab22356ce020))
* **demo:** every capability, running, served by the framework it demonstrates ([8c50ad3](https://github.com/raminjafary/weft/commit/8c50ad37348950d0253d7e925b46f5f5d8180444))
* **ir:** incremental recompute, and measure the claim phase 6 exists to make ([dbc89ff](https://github.com/raminjafary/weft/commit/dbc89ffe7eda42b92f437099d428e11187ca86f9))
* **kernel:** intents, and therefore everything that needed a write ([654715c](https://github.com/raminjafary/weft/commit/654715c9503d7ff0bcb8f10c35bde9c6115408e9))
* **kernel:** carry the frames, in all three bindings the design names ([55ed0bd](https://github.com/raminjafary/weft/commit/55ed0bda2b3e7b083ea3366e4a08740982745d64))
* **client:** write the property behind a control, not its attribute ([6006092](https://github.com/raminjafary/weft/commit/6006092a71f05d0da97af04b7539604a3dc02a40))
* **client:** adopt component instances and address them in a delta ([0b80d23](https://github.com/raminjafary/weft/commit/0b80d2352c5a05d9b656d40b055ce31c060f185a))
* **ir:** carry derived values as an expression tree the client can evaluate ([8a3b410](https://github.com/raminjafary/weft/commit/8a3b410aea1c30ba86b7b1aa95bde243ada0b42c))
* **kernel:** stream slots in order or fastest-first ([27b0057](https://github.com/raminjafary/weft/commit/27b0057732a12575441671db0377548238c650cf))

### 🐛 Bug Fixes

* the byte budgets were measured into a terminal and nowhere else ([e127c8e](https://github.com/raminjafary/weft/commit/e127c8e187d7e6b9728a81d73ec64ab4936cd4fc))
* every named refusal now says something, and the 8 KB path is back inside its ceiling ([b62b857](https://github.com/raminjafary/weft/commit/b62b85734e708481507938b7932e2297de1abf9a))
* an unreachable device keeps the error that said why ([bf34b8f](https://github.com/raminjafary/weft/commit/bf34b8faf75a0b19330f570dfa41fc9fb8da824a))
* a device lane pointed at nothing says so instead of failing to fetch ([c580dfe](https://github.com/raminjafary/weft/commit/c580dfeea8064ebc120c4f72f32aeb0d99694da7))

### ♻️ Code Refactoring

* **repo:** the scope is @weftjs, and three things a rename could break silently ([bea1027](https://github.com/raminjafary/weft/commit/bea102788a322b6f49a7cdb5a6362e6ad7161252))
* **repo:** the framework is @weft/core, because npm already serves a weft ([524705f](https://github.com/raminjafary/weft/commit/524705ff608dc75ab2cb318579d1a6f6bf6c3d34))
* **kernel:** move the Node server out, so the kernel imports only web standards ([0e3c47c](https://github.com/raminjafary/weft/commit/0e3c47c59a18ca5c155eb67b94f4958d200c002c))

### 📝 Documentation

* **repo:** ten packages declare a README in `files`, and none of them had one ([6a7d97c](https://github.com/raminjafary/weft/commit/6a7d97c7a73a0df9d790e36d2e4627136a863829))

### ✅ Testing

* gate the kernel's byte budget against the design's 8 KB ([18eee7c](https://github.com/raminjafary/weft/commit/18eee7ca5e3a0db33847349b2c185f2d8d95ac75))

### 📦 Build & Dependencies

* **repo:** a release is one command, and every version it writes comes from the commits ([c949c45](https://github.com/raminjafary/weft/commit/c949c458b7bf4a012014498a0cf37e493dc42fef))
* **repo:** make every package installable, and give the repo a build step ([a8642d9](https://github.com/raminjafary/weft/commit/a8642d94b3963b40bf5b4025e5cabb967895e72c))
* **repo:** add oxlint, prettier, husky, lint-staged, and pin every dependency ([9e496c8](https://github.com/raminjafary/weft/commit/9e496c8eebd5a9ca4b7f8887fba2d60d946eb05a))

### 🌱 Foundations

The commits below predate this repository's Conventional Commits rule. They are the work the convention was adopted in the middle of, kept here because 0.1.0 contains them.

* Measure the byte budgets, and make them a gate ([7664fd0](https://github.com/raminjafary/weft/commit/7664fd00ec53fbcfe9c5acdfbcaf384a958f44b8))
* Resident templates over Warp, and the protocol's first real run ([02aaa9f](https://github.com/raminjafary/weft/commit/02aaa9f5877997bc95dd6336ea176556d9bbbb6c))
* A client runtime, and a finding reversed ([9c62b9a](https://github.com/raminjafary/weft/commit/9c62b9a127fa20573e61f74a70df9210e073044e))
* Type-driven escape elision, and a correction ([e01f9ec](https://github.com/raminjafary/weft/commit/e01f9ecfd08635e736177bf3b8d2abd17328111b))
* Cut the data form, on the evidence ([13605f5](https://github.com/raminjafary/weft/commit/13605f5914a00b62f0c5351a5434b689f5e247bd))
* The phase-zero gate: RR7, a slow hole, and injected latency ([8e32485](https://github.com/raminjafary/weft/commit/8e32485ce095dcc568538dfec99b35c58eadbf9f))
* Benchmark compiled IR, not a hand-written one ([13d1c1f](https://github.com/raminjafary/weft/commit/13d1c1f39d311c2b8be872d8645a281a18455d26))
* Phase zero: benchmark harness and versioned IRs ([64f5f8e](https://github.com/raminjafary/weft/commit/64f5f8e2dfc5e3a436c52759bf965a75bdeefe04))
