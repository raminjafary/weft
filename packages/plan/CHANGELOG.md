# Changelog

Every commit in this repository appears here, not only `feat` and `fix`. The sections are
generated from Conventional Commit types by `scripts/release/`, and a package changelog holds
the commits scoped to that package.

## [0.1.3](https://github.com/raminjafary/weft/compare/v0.2.0...HEAD) (2026-08-28)

### ⬆️ Workspace Dependencies

* bumped for `@weftjs/adapters@0.1.3`
* bumped for `@weftjs/compiler@0.1.3`
* bumped for `@weftjs/kernel@0.2.1`

## [0.1.2](https://github.com/raminjafary/weft/compare/v0.1.1...v0.2.0) (2026-08-28)

### ⬆️ Workspace Dependencies

* bumped for `@weftjs/adapters@0.1.2`
* bumped for `@weftjs/compiler@0.1.2`
* bumped for `@weftjs/kernel@0.2.0`

## [0.1.1](https://github.com/raminjafary/weft/compare/v0.1.0...v0.1.1) (2026-08-28)

### ⬆️ Workspace Dependencies

* bumped for `@weftjs/adapters@0.1.1`
* bumped for `@weftjs/compiler@0.1.1`
* bumped for `@weftjs/ir@0.1.1`
* bumped for `@weftjs/kernel@0.1.1`

## 0.1.0 (2026-08-28)

### ✨ Features

* **kernel, weft, demo:** a document that is a chain of layouts, checked as one document ([b18573f](https://github.com/raminjafary/weft/commit/b18573f2ba9663f523b0480407c1e5d8e475151e))
* **weft, kernel:** four plan declarations that were recorded and read by nothing ([24227f2](https://github.com/raminjafary/weft/commit/24227f2b0aa0a48c68a693111f3555e4cfdc82a4))
* a shell is a plan whose leaves may live somewhere else ([805f795](https://github.com/raminjafary/weft/commit/805f795a9f96fb1f66072c7eb8e60c52370958f7))
* name the document, and lower a plan into a route ([969729c](https://github.com/raminjafary/weft/commit/969729c40e00f3dc412c914255afdf197b2781f7))
* declare placement, and check it against what the compiler inferred ([c987e87](https://github.com/raminjafary/weft/commit/c987e876cbca58df2c377b1ea7ba08ff621b5e27))

### 📝 Documentation

* **kernel, client, ir, weft:** another 88 exports documented ([6b1b988](https://github.com/raminjafary/weft/commit/6b1b988b929112c03b10cbac920923ccc261f2c6))
* **ir, warp, kernel:** the first 112 undocumented exports get a doc comment ([3001ca8](https://github.com/raminjafary/weft/commit/3001ca8d418d646a1fdcba821ae5b26d78089c0e))

### ✅ Testing

* **weft:** the three warnings that fired and nothing asserted ([5d8ae7b](https://github.com/raminjafary/weft/commit/5d8ae7bd6a416abc9b25bcbde635b8bdf1b44d64))
* route three plans, serve them, and refuse the incomplete ones ([3d1c336](https://github.com/raminjafary/weft/commit/3d1c33634f189f5f9f7b497d087e1996f40439f3))
* check the plan fixtures against what the compiler actually inferred ([170d2cc](https://github.com/raminjafary/weft/commit/170d2cc696e9566fd21959544e7513754821f59f))
