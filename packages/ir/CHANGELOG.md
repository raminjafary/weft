# Changelog

Every commit in this repository appears here, not only `feat` and `fix`. The sections are
generated from Conventional Commit types by `scripts/release/`, and a package changelog holds
the commits scoped to that package.

## [0.1.1](https://github.com/raminjafary/weft/compare/v0.1.0...v0.1.1) (2026-08-28)

### 🐛 Bug Fixes

* E_INVALID_DOCUMENT says what an invalid document is, not just its own name ([c1bb5ad](https://github.com/raminjafary/weft/commit/c1bb5adb3c51b8941532ac8eeec163c8e6954d0b))

## 0.1.0 (2026-08-28)

### ✨ Features

* **compiler:** a row may interpolate its item, not only its fields ([0c50d13](https://github.com/raminjafary/weft/commit/0c50d1397404d1d2ec92d47373b4e5bd31ce6927))
* **compiler:** a list row may name its position ([09ab455](https://github.com/raminjafary/weft/commit/09ab4555b5788d09440ded42dc1fae3811ba1bb2))
* **compiler:** a template can hold a choice of markup ([4e26315](https://github.com/raminjafary/weft/commit/4e263150d9bf934bf758ff301c7c83520effeed3))
* **compiler, client:** a hole may hold a conditional value ([7ca9daf](https://github.com/raminjafary/weft/commit/7ca9daff78727ca039ed60f1cea879baa16a04ea))
* **kernel, client:** the rung the surgical ladder was missing, and what a list taught it ([0d1590a](https://github.com/raminjafary/weft/commit/0d1590a58a6aa827385b11904e855592ba640f31))
* **kernel:** a region is a fragment that lives somewhere else, and the check that lets its frames in ([634497f](https://github.com/raminjafary/weft/commit/634497f5f782a4527b28563b786dc604b4b06ee0))
* **compiler:** a component in any shape, and the two refusals that go away ([1073ae5](https://github.com/raminjafary/weft/commit/1073ae561e3baefb4ed1c3602d8dc06bad16c7b3))
* incremental recompute, and measure the claim phase 6 exists to make ([dbc89ff](https://github.com/raminjafary/weft/commit/dbc89ffe7eda42b92f437099d428e11187ca86f9))
* **kernel:** carry the frames, in all three bindings the design names ([55ed0bd](https://github.com/raminjafary/weft/commit/55ed0bda2b3e7b083ea3366e4a08740982745d64))
* contain a private fragment instead of letting it taint the route ([e775c5e](https://github.com/raminjafary/weft/commit/e775c5e307066b53379e7b66c8e0fc371913b369))
* compose fragments through a component hole ([67e3b46](https://github.com/raminjafary/weft/commit/67e3b465db76243d0e8b1fdf69752c9a3d2ed1b5))
* carry derived values as an expression tree the client can evaluate ([8a3b410](https://github.com/raminjafary/weft/commit/8a3b410aea1c30ba86b7b1aa95bde243ada0b42c))
* **compiler:** infer effects and ban untracked reads ([81074a9](https://github.com/raminjafary/weft/commit/81074a97afada5d4fb4a7ffc1890dd7c318e9394))

### 🐛 Bug Fixes

* **kernel:** a shell was cut by a different switch from the one that renders ([94b36b2](https://github.com/raminjafary/weft/commit/94b36b2793b762009a03cf7892b260f547736d28))
* every named refusal now says something, and the 8 KB path is back inside its ceiling ([b62b857](https://github.com/raminjafary/weft/commit/b62b85734e708481507938b7932e2297de1abf9a))
* a raw value hole cannot serve a delta ([cfa8f2d](https://github.com/raminjafary/weft/commit/cfa8f2d6478a1dee39ebea50196c523b42bf7cbb))

### ♻️ Code Refactoring

* **repo:** the scope is @weftjs, and three things a rename could break silently ([bea1027](https://github.com/raminjafary/weft/commit/bea102788a322b6f49a7cdb5a6362e6ad7161252))
* **repo:** the framework is @weft/core, because npm already serves a weft ([524705f](https://github.com/raminjafary/weft/commit/524705ff608dc75ab2cb318579d1a6f6bf6c3d34))

### 📝 Documentation

* **repo:** ten packages declare a README in `files`, and none of them had one ([6a7d97c](https://github.com/raminjafary/weft/commit/6a7d97c7a73a0df9d790e36d2e4627136a863829))
* **adapters, client, compiler:** another 121 exports documented ([bc0c7e9](https://github.com/raminjafary/weft/commit/bc0c7e94f3819472482850d975373b9d5be72ccb))
* **kernel, client, plan, weft:** another 88 exports documented ([6b1b988](https://github.com/raminjafary/weft/commit/6b1b988b929112c03b10cbac920923ccc261f2c6))
* **warp, kernel, plan:** the first 112 undocumented exports get a doc comment ([3001ca8](https://github.com/raminjafary/weft/commit/3001ca8d418d646a1fdcba821ae5b26d78089c0e))

### 📦 Build & Dependencies

* **repo:** a release is one command, and every version it writes comes from the commits ([c949c45](https://github.com/raminjafary/weft/commit/c949c458b7bf4a012014498a0cf37e493dc42fef))
* **repo:** make every package installable, and give the repo a build step ([a8642d9](https://github.com/raminjafary/weft/commit/a8642d94b3963b40bf5b4025e5cabb967895e72c))
* **repo:** add oxlint, prettier, husky, lint-staged, and pin every dependency ([9e496c8](https://github.com/raminjafary/weft/commit/9e496c8eebd5a9ca4b7f8887fba2d60d946eb05a))

### 🌱 Foundations

The commits below predate this repository's Conventional Commits rule. They are the work the convention was adopted in the middle of, kept here because 0.1.0 contains them.

* A client runtime, and a finding reversed ([9c62b9a](https://github.com/raminjafary/weft/commit/9c62b9a127fa20573e61f74a70df9210e073044e))
* Cut the data form, on the evidence ([13605f5](https://github.com/raminjafary/weft/commit/13605f5914a00b62f0c5351a5434b689f5e247bd))
* Template IR 1.1.0: element paths, text anchors, and a relaxed event rule ([140a131](https://github.com/raminjafary/weft/commit/140a1317ec6cede7d4cd8fcaa68219fbb49629fb))
* Phase zero: benchmark harness and versioned IRs ([64f5f8e](https://github.com/raminjafary/weft/commit/64f5f8e2dfc5e3a436c52759bf965a75bdeefe04))
