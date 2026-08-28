# Changelog

Every commit in this repository appears here, not only `feat` and `fix`. The sections are
generated from Conventional Commit types by `scripts/release/`, and a package changelog holds
the commits scoped to that package.

## [0.1.6](https://github.com/raminjafary/weft/compare/v0.2.3...HEAD) (2026-08-28)

### 🐛 Bug Fixes

* a route's loader reads the request, and the cache key did not know ([bac726d](https://github.com/raminjafary/weft/commit/bac726ddb0016d0428564e588ef09c49703074ec))

## [0.1.5](https://github.com/raminjafary/weft/compare/v0.2.2...v0.2.3) (2026-08-28)

### ⬆️ Workspace Dependencies

* bumped for `@weftjs/core@0.2.3`

## [0.1.4](https://github.com/raminjafary/weft/compare/v0.2.1...v0.2.2) (2026-08-28)

### ⬆️ Workspace Dependencies

* bumped for `@weftjs/core@0.2.2`

## [0.1.3](https://github.com/raminjafary/weft/compare/v0.2.0...v0.2.1) (2026-08-28)

### 🐛 Bug Fixes

* an optional peer imported statically is not optional, and npm create weft died on it ([6e49fc0](https://github.com/raminjafary/weft/commit/6e49fc0a028c7dfde0f2de8ec6749b5e17879147))

## [0.1.2](https://github.com/raminjafary/weft/compare/v0.1.1...v0.2.0) (2026-08-28)

### ⚡️ Performance Improvements

* **weft:** a production build stops shipping its own documentation ([37e803b](https://github.com/raminjafary/weft/commit/37e803b2408269a8218f790008d0deae3c25b6b1))

## [0.1.1](https://github.com/raminjafary/weft/compare/v0.1.0...v0.1.1) (2026-08-28)

### ⬆️ Workspace Dependencies

* bumped for `@weftjs/core@0.1.1`
* bumped for `@weftjs/ir@0.1.1`

## 0.1.0 (2026-08-28)

### ✨ Features

* **weft:** a component's stylesheet can be the component's ([d513b48](https://github.com/raminjafary/weft/commit/d513b483a5f49c19131efbd02fb35b8755119955))
* **ir:** a row may interpolate its item, not only its fields ([0c50d13](https://github.com/raminjafary/weft/commit/0c50d1397404d1d2ec92d47373b4e5bd31ce6927))
* **ir:** a list row may name its position ([09ab455](https://github.com/raminjafary/weft/commit/09ab4555b5788d09440ded42dc1fae3811ba1bb2))
* **ir:** a template can hold a choice of markup ([4e26315](https://github.com/raminjafary/weft/commit/4e263150d9bf934bf758ff301c7c83520effeed3))
* **ir, client:** a hole may hold a conditional value ([7ca9daf](https://github.com/raminjafary/weft/commit/7ca9daff78727ca039ed60f1cea879baa16a04ea))
* a file set that exists only in memory ([70c7e2b](https://github.com/raminjafary/weft/commit/70c7e2b073719b02a91054025fb11250709c4cc5))
* a component in any shape, and the two refusals that go away ([1073ae5](https://github.com/raminjafary/weft/commit/1073ae561e3baefb4ed1c3602d8dc06bad16c7b3))
* compose fragments across modules, in dependency order ([f76ab07](https://github.com/raminjafary/weft/commit/f76ab07aae844089aa00d628f14e1855fd623fe1))
* **client:** write the property behind a control, not its attribute ([6006092](https://github.com/raminjafary/weft/commit/6006092a71f05d0da97af04b7539604a3dc02a40))
* **client:** adopt component instances and address them in a delta ([0b80d23](https://github.com/raminjafary/weft/commit/0b80d2352c5a05d9b656d40b055ce31c060f185a))
* **ir:** compose fragments through a component hole ([67e3b46](https://github.com/raminjafary/weft/commit/67e3b465db76243d0e8b1fdf69752c9a3d2ed1b5))
* **ir:** carry derived values as an expression tree the client can evaluate ([8a3b410](https://github.com/raminjafary/weft/commit/8a3b410aea1c30ba86b7b1aa95bde243ada0b42c))
* infer effects and ban untracked reads ([81074a9](https://github.com/raminjafary/weft/commit/81074a97afada5d4fb4a7ffc1890dd7c318e9394))

### 🐛 Bug Fixes

* a chained conditional dropped every arm but the first ([235b8c2](https://github.com/raminjafary/weft/commit/235b8c2cf7cf64b24d863d276d41689bdd8ae504))
* every named refusal now says something, and the 8 KB path is back inside its ceiling ([b62b857](https://github.com/raminjafary/weft/commit/b62b85734e708481507938b7932e2297de1abf9a))
* an intent id names where the intent lives, not where it was imported from ([cf3c1ad](https://github.com/raminjafary/weft/commit/cf3c1ade0d318063477660750dabf967f9b093af))

### ♻️ Code Refactoring

* **repo:** the scope is @weftjs, and three things a rename could break silently ([bea1027](https://github.com/raminjafary/weft/commit/bea102788a322b6f49a7cdb5a6362e6ad7161252))
* **repo:** the framework is @weft/core, because npm already serves a weft ([524705f](https://github.com/raminjafary/weft/commit/524705ff608dc75ab2cb318579d1a6f6bf6c3d34))

### 📝 Documentation

* **repo:** ten packages declare a README in `files`, and none of them had one ([6a7d97c](https://github.com/raminjafary/weft/commit/6a7d97c7a73a0df9d790e36d2e4627136a863829))
* **repo:** every export in the framework has a doc comment, and that is now a gate ([c77a1c0](https://github.com/raminjafary/weft/commit/c77a1c011e8d13a18c0e77b45ee8b55a84d89df1))
* **adapters, client, ir:** another 121 exports documented ([bc0c7e9](https://github.com/raminjafary/weft/commit/bc0c7e94f3819472482850d975373b9d5be72ccb))

### ✅ Testing

* add fixtures for the whole keyable read surface, and for leaving it ([36af9e3](https://github.com/raminjafary/weft/commit/36af9e3b1a0777b9cab639c6392ecf4437e76b4f))
* cover what a component lowers to and what it refuses ([bb29bbe](https://github.com/raminjafary/weft/commit/bb29bbe98a0451e0241c25ffb09445caaceddf68))

### 📦 Build & Dependencies

* **repo:** a release is one command, and every version it writes comes from the commits ([c949c45](https://github.com/raminjafary/weft/commit/c949c458b7bf4a012014498a0cf37e493dc42fef))
* **repo:** make every package installable, and give the repo a build step ([a8642d9](https://github.com/raminjafary/weft/commit/a8642d94b3963b40bf5b4025e5cabb967895e72c))
* **repo:** add oxlint, prettier, husky, lint-staged, and pin every dependency ([9e496c8](https://github.com/raminjafary/weft/commit/9e496c8eebd5a9ca4b7f8887fba2d60d946eb05a))
* **repo:** enforce conventional commits ([fdf3d72](https://github.com/raminjafary/weft/commit/fdf3d721d5c0b831a13ddd03479f2cd22c6fd9e2))

### 🌱 Foundations

The commits below predate this repository's Conventional Commits rule. They are the work the convention was adopted in the middle of, kept here because 0.1.0 contains them.

* A client runtime, and a finding reversed ([9c62b9a](https://github.com/raminjafary/weft/commit/9c62b9a127fa20573e61f74a70df9210e073044e))
* Type-driven escape elision, and a correction ([e01f9ec](https://github.com/raminjafary/weft/commit/e01f9ecfd08635e736177bf3b8d2abd17328111b))
* Compile TSX fragments to the IR, on Oxc ([c3865ee](https://github.com/raminjafary/weft/commit/c3865ee1d909aa58c5f3f4df26cdfd9c89443bca))
