# Changelog

Every commit in this repository appears here, not only `feat` and `fix`. The sections are
generated from Conventional Commit types by `scripts/release/`, and a package changelog holds
the commits scoped to that package.

## [0.1.6](https://github.com/raminjafary/weft/compare/v0.2.3...HEAD) (2026-08-28)

### ⬆️ Workspace Dependencies

* bumped for `@weftjs/adapters@0.1.6`
* bumped for `@weftjs/bench@0.3.3`
* bumped for `@weftjs/client@0.1.1`
* bumped for `@weftjs/compiler@0.1.6`
* bumped for `@weftjs/core@0.2.4`
* bumped for `@weftjs/kernel@0.2.4`
* bumped for `@weftjs/plan@0.1.6`

## [0.1.5](https://github.com/raminjafary/weft/compare/v0.2.2...v0.2.3) (2026-08-28)

### ⬆️ Workspace Dependencies

* bumped for `@weftjs/adapters@0.1.5`
* bumped for `@weftjs/bench@0.3.2`
* bumped for `@weftjs/compiler@0.1.5`
* bumped for `@weftjs/core@0.2.3`
* bumped for `@weftjs/kernel@0.2.3`
* bumped for `@weftjs/plan@0.1.5`

## [0.1.4](https://github.com/raminjafary/weft/compare/v0.2.1...v0.2.2) (2026-08-28)

### ⬆️ Workspace Dependencies

* bumped for `@weftjs/adapters@0.1.4`
* bumped for `@weftjs/bench@0.3.1`
* bumped for `@weftjs/compiler@0.1.4`
* bumped for `@weftjs/core@0.2.2`
* bumped for `@weftjs/kernel@0.2.2`
* bumped for `@weftjs/plan@0.1.4`
* bumped for `@weftjs/warp@0.1.1`

## [0.1.3](https://github.com/raminjafary/weft/compare/v0.2.0...v0.2.1) (2026-08-28)

### ⬆️ Workspace Dependencies

* bumped for `@weftjs/adapters@0.1.3`
* bumped for `@weftjs/bench@0.3.0`
* bumped for `@weftjs/compiler@0.1.3`
* bumped for `@weftjs/core@0.2.1`
* bumped for `@weftjs/kernel@0.2.1`
* bumped for `@weftjs/plan@0.1.3`

## [0.1.2](https://github.com/raminjafary/weft/compare/v0.1.1...v0.2.0) (2026-08-28)

### ⬆️ Workspace Dependencies

* bumped for `@weftjs/adapters@0.1.2`
* bumped for `@weftjs/bench@0.2.0`
* bumped for `@weftjs/compiler@0.1.2`
* bumped for `@weftjs/core@0.2.0`
* bumped for `@weftjs/kernel@0.2.0`
* bumped for `@weftjs/plan@0.1.2`

## [0.1.1](https://github.com/raminjafary/weft/compare/v0.1.0...v0.1.1) (2026-08-28)

### 🐛 Bug Fixes

* **repo:** five map spreads become the thing they were spreading for, and the rule goes off ([6fb5ad8](https://github.com/raminjafary/weft/commit/6fb5ad812541986b9110e9ec1147ac3c00706e98))

## 0.1.0 (2026-08-28)

### ✨ Features

* **weft:** a component's stylesheet can be the component's ([d513b48](https://github.com/raminjafary/weft/commit/d513b483a5f49c19131efbd02fb35b8755119955))
* **kernel:** a region is a fragment that lives somewhere else, and the check that lets its frames in ([634497f](https://github.com/raminjafary/weft/commit/634497f5f782a4527b28563b786dc604b4b06ee0))
* **kernel:** who may run an intent, whether this deployment issued it, and a plan a client can ask for ([bdfcbd7](https://github.com/raminjafary/weft/commit/bdfcbd7d0947f03d2bbbc56a77e3ea460cec59c7))
* **weft:** a plan generated from what the renders actually cost ([3913ddd](https://github.com/raminjafary/weft/commit/3913ddd01f01bd47f8e3f847ad9766c251074977))
* **kernel:** the six ports that were declared and had nothing behind them ([215312a](https://github.com/raminjafary/weft/commit/215312ab796f33712fcac0dba5d4eee937f3b4f6))
* the station about arriving at the station ([fa367d0](https://github.com/raminjafary/weft/commit/fa367d0c43fc0785678ad417e8fa3a9c1d1f87d3))
* **weft:** a page that reads nothing is a file ([8d89bd2](https://github.com/raminjafary/weft/commit/8d89bd24625ceaa059994f6ce57eab22356ce020))

### 🐛 Bug Fixes

* **weft:** the page painted at the top and then jumped, on every scrolled refresh ([c95429d](https://github.com/raminjafary/weft/commit/c95429d8c55cc8975fd8ed907eabc95bd5d7636c))
* **docs, demo:** no application declared color-scheme, so every refresh began with a white frame ([3e49416](https://github.com/raminjafary/weft/commit/3e49416496d31a5beee2d7d04083cbbb3e314b5b))

### ♻️ Code Refactoring

* **repo:** the scope is @weftjs, and three things a rename could break silently ([bea1027](https://github.com/raminjafary/weft/commit/bea102788a322b6f49a7cdb5a6362e6ad7161252))
* **weft:** each generated URL root is the initial of what is behind it ([f5be654](https://github.com/raminjafary/weft/commit/f5be654d07455402b307cb88d1c0add500054807))
* **repo:** the framework is @weft/core, because npm already serves a weft ([524705f](https://github.com/raminjafary/weft/commit/524705ff608dc75ab2cb318579d1a6f6bf6c3d34))
* fixtures named for the case they demonstrate ([cb83b8e](https://github.com/raminjafary/weft/commit/cb83b8e83955b7196920bc4e6ca488cc1b239f5a))
* **repo:** the stations become @weft/inspector, and the demo becomes an application ([827b14c](https://github.com/raminjafary/weft/commit/827b14cc567448ce63488f49f55f2076acbf5b4f))

### 📝 Documentation

* **repo:** the README keeps the numbers and loses the prose around them ([1feb415](https://github.com/raminjafary/weft/commit/1feb415ad60b73ad393d3cc6124ef02613e37542))

### ✅ Testing

* **weft, plan:** the three warnings that fired and nothing asserted ([5d8ae7b](https://github.com/raminjafary/weft/commit/5d8ae7bd6a416abc9b25bcbde635b8bdf1b44d64))

### 📦 Build & Dependencies

* **repo:** a release is one command, and every version it writes comes from the commits ([c949c45](https://github.com/raminjafary/weft/commit/c949c458b7bf4a012014498a0cf37e493dc42fef))

### 🚚 Chores

* **repo:** the byte budgets the merged tree measures, and the inspector's first one ([e478c68](https://github.com/raminjafary/weft/commit/e478c680aaa201dde492eb60fb716205da55476d))
