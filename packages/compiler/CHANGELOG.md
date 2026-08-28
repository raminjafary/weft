# Changelog

Every commit in this repository appears here, not only `feat` and `fix`. The sections are
generated from Conventional Commit types by `scripts/release/`, and a package changelog holds
the commits scoped to that package.

## [0.1.3](https://github.com/raminjafary/weft/compare/v0.2.0...HEAD) (2026-08-28)

### 🐛 Bug Fixes

* an optional peer imported statically is not optional, and npm create weft died on it ([6e49fc0](https://github.com/raminjafary/weft/commit/6e49fc0a028c7dfde0f2de8ec6749b5e17879147))

## [0.1.2](https://github.com/raminjafary/weft/compare/v0.1.1...v0.2.0) (2026-08-28)

### ⬆️ Workspace Dependencies

* bumped for `@weftjs/core@0.2.0`

## [0.1.1](https://github.com/raminjafary/weft/compare/v0.1.0...v0.1.1) (2026-08-28)

### ⬆️ Workspace Dependencies

* bumped for `@weftjs/core@0.1.1`
* bumped for `@weftjs/ir@0.1.1`

## 0.1.0 (2026-08-28)

### ✨ Features

* **ir:** a row may interpolate its item, not only its fields ([0c50d13](https://github.com/raminjafary/weft/commit/0c50d1397404d1d2ec92d47373b4e5bd31ce6927))
* **ir:** a list row may name its position ([09ab455](https://github.com/raminjafary/weft/commit/09ab4555b5788d09440ded42dc1fae3811ba1bb2))
* **ir:** a template can hold a choice of markup ([4e26315](https://github.com/raminjafary/weft/commit/4e263150d9bf934bf758ff301c7c83520effeed3))
* **ir, client:** a hole may hold a conditional value ([7ca9daf](https://github.com/raminjafary/weft/commit/7ca9daff78727ca039ed60f1cea879baa16a04ea))
* a file set that exists only in memory ([70c7e2b](https://github.com/raminjafary/weft/commit/70c7e2b073719b02a91054025fb11250709c4cc5))
* a component in any shape, and the two refusals that go away ([1073ae5](https://github.com/raminjafary/weft/commit/1073ae561e3baefb4ed1c3602d8dc06bad16c7b3))
* compose fragments across modules, in dependency order ([f76ab07](https://github.com/raminjafary/weft/commit/f76ab07aae844089aa00d628f14e1855fd623fe1))
* infer effects and ban untracked reads ([81074a9](https://github.com/raminjafary/weft/commit/81074a97afada5d4fb4a7ffc1890dd7c318e9394))

### 🐛 Bug Fixes

* a chained conditional dropped every arm but the first ([235b8c2](https://github.com/raminjafary/weft/commit/235b8c2cf7cf64b24d863d276d41689bdd8ae504))
* an intent id names where the intent lives, not where it was imported from ([cf3c1ad](https://github.com/raminjafary/weft/commit/cf3c1ade0d318063477660750dabf967f9b093af))

### 📝 Documentation

* **adapters, client, ir:** another 121 exports documented ([bc0c7e9](https://github.com/raminjafary/weft/commit/bc0c7e94f3819472482850d975373b9d5be72ccb))

### ✅ Testing

* add fixtures for the whole keyable read surface, and for leaving it ([36af9e3](https://github.com/raminjafary/weft/commit/36af9e3b1a0777b9cab639c6392ecf4437e76b4f))
* cover what a component lowers to and what it refuses ([bb29bbe](https://github.com/raminjafary/weft/commit/bb29bbe98a0451e0241c25ffb09445caaceddf68))
