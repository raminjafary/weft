# Changelog

Every commit in this repository appears here, not only `feat` and `fix`. The sections are
generated from Conventional Commit types by `scripts/release/`, and a package changelog holds
the commits scoped to that package.

## [0.3.3](https://github.com/raminjafary/weft/compare/v0.2.2...HEAD) (2026-08-28)

### ⬆️ Workspace Dependencies

* bumped for `@weftjs/compiler@0.1.5`
* bumped for `@weftjs/core@0.2.3`
* bumped for `@weftjs/kernel@0.2.3`

## [0.3.2](https://github.com/raminjafary/weft/compare/v0.2.1...v0.2.2) (2026-08-28)

### ⬆️ Workspace Dependencies

* bumped for `@weftjs/compiler@0.1.4`
* bumped for `@weftjs/core@0.2.2`
* bumped for `@weftjs/kernel@0.2.2`
* bumped for `@weftjs/warp@0.1.1`

## [0.3.1](https://github.com/raminjafary/weft/compare/v0.2.0...v0.2.1) (2026-08-28)

### 🐛 Bug Fixes

* **repo:** the navigation table has both its columns, and the download figure is checkable ([f909a40](https://github.com/raminjafary/weft/commit/f909a404c5961c9a725b7864ac58f0f19b648f09))

## [0.3.0](https://github.com/raminjafary/weft/compare/v0.1.1...v0.2.0) (2026-08-28)

### ✨ Features

* a reference section, one page per thing you write ([b0e82d3](https://github.com/raminjafary/weft/commit/b0e82d37f75216819d4d9c15e1300f179eebfa11))
* **weft:** a sitemap generated from what was published, and a canonical URL per route ([00472df](https://github.com/raminjafary/weft/commit/00472df756b1f62666b4cc1792bf975a0672f21f))
* **kernel:** a channel binding that holds nothing, so a host with no process can carry one ([559eb88](https://github.com/raminjafary/weft/commit/559eb88431646d0e37f993ba58157727814d1455))
* the tutorial is nineteen steps, because that is what it takes ([87840c6](https://github.com/raminjafary/weft/commit/87840c66884671bd70305e439a5a9eb8c3ac81da))

### 🐛 Bug Fixes

* **repo:** every number in every document, re-measured against the run that shipped with it ([6a4ff00](https://github.com/raminjafary/weft/commit/6a4ff00d6d72bb1e585c92443528076eed12fd1a))
* the theme sweep's pause matched every figure and paused none of them ([41ad38d](https://github.com/raminjafary/weft/commit/41ad38def0ef03c26080fd9043056599fc8105eb))
* a string preceded by a bracket is a string, not two punctuation marks ([2fd1c3e](https://github.com/raminjafary/weft/commit/2fd1c3e1d745b44fbecad7dbc86dce82c0db973a))
* the vote count moves, and the reason it did not is now a build warning ([a324e94](https://github.com/raminjafary/weft/commit/a324e94d2a26d945ee8dc91ffcb36d01004e863d))
* **weft:** a slow route no longer paints over the one you clicked after it ([385c9de](https://github.com/raminjafary/weft/commit/385c9dea9e7cc5bdd39bae63b551cb282ffb2983))
* every figure on the site is read from the run that measured it ([d638af1](https://github.com/raminjafary/weft/commit/d638af1a94938aa6382062749780e7b13cb93329))
* **weft:** a port a browser refuses is a channel that never connects and never says so ([f8d8080](https://github.com/raminjafary/weft/commit/f8d808020729b6851dd32d29af0d32382ed772bd))

### ⚡️ Performance Improvements

* **weft:** a document names the modules it will fetch, so they stop arriving one hop at a time ([bc263cd](https://github.com/raminjafary/weft/commit/bc263cdcf243dd742c4283faf0d80a88f1cc2f67))
* **weft:** a production build stops shipping its own documentation ([37e803b](https://github.com/raminjafary/weft/commit/37e803b2408269a8218f790008d0deae3c25b6b1))

### ♻️ Code Refactoring

* the search page goes, and everything that existed to serve it ([657ba9e](https://github.com/raminjafary/weft/commit/657ba9e59288dea49532b4274d0aa3540050d8ab))

### 📝 Documentation

* **spec:** the specs catch up, and "a folder is an application" says what it means ([9bec7b3](https://github.com/raminjafary/weft/commit/9bec7b3da9f8e3a974ac1d78b837162830b0908c))
* the protocol, drawn — frames, epochs, and the delay a turn actually costs ([faae397](https://github.com/raminjafary/weft/commit/faae397997b6c0470e3b6b440236e98b15027518))
* delivery and negotiation, which the site had never actually explained ([d4bf609](https://github.com/raminjafary/weft/commit/d4bf609d47a690879bcc49720a3ad56fc7ad4fcd))

## [0.2.0](https://github.com/raminjafary/weft/compare/v0.1.0...v0.1.1) (2026-08-28)

### ✨ Features

* the six pages the redesign had not reached, and the rhythm they all share ([8e88c05](https://github.com/raminjafary/weft/commit/8e88c059146c2f4ef409135e888ce9b953fbfc24))

### 🐛 Bug Fixes

* the tutorial index has no rail, which is what the design draws ([bf92e3d](https://github.com/raminjafary/weft/commit/bf92e3d69629a5b4683d49046f5e59d52cb89587))
* **repo:** five map spreads become the thing they were spreading for, and the rule goes off ([6fb5ad8](https://github.com/raminjafary/weft/commit/6fb5ad812541986b9110e9ec1147ac3c00706e98))
* a refusal whose message holds a nested template literal is read whole ([9d1cb3d](https://github.com/raminjafary/weft/commit/9d1cb3dd7ac77ec3ec83eeb784cdadb5896f7714))
* **weft:** a client module is served at a .js URL, whatever the source extension is ([bffbf1f](https://github.com/raminjafary/weft/commit/bffbf1ff77640a4dae767cf02acc85de4a8f9a8d))

## 0.1.0 (2026-08-28)

### ✨ Features

* **repo:** the docs site, the demo and a new application all use both asset directories ([b2516af](https://github.com/raminjafary/weft/commit/b2516af07176ee11815a08b2cf4d75bb612f4527))
* **weft:** a shared cache may answer with a document the build proved invariant ([4cf5f4a](https://github.com/raminjafary/weft/commit/4cf5f4a9a03b6b7cf7423cefa47df7ed8b0c164f))
* an export links the documents that specify it, and a package its ceiling ([3583fc4](https://github.com/raminjafary/weft/commit/3583fc41487bc1f152d8085605ef720aa41d68d8))
* the glossary says which part of the framework each word belongs to ([15c8ac6](https://github.com/raminjafary/weft/commit/15c8ac6c6b24f3dcbbc2e940e6fa64a99010be22))
* the gallery is grouped by what the examples are about ([a031e1e](https://github.com/raminjafary/weft/commit/a031e1e569d0ac55aaa1b2dd29d2cfce400f6440))
* an error page says which guide introduces it, and what stands beside it ([e8bd076](https://github.com/raminjafary/weft/commit/e8bd0767639a45a92f6ca90087faf9d2e4a6d5cd))
* the API page says what a file refuses, and how far a section runs ([7ed553f](https://github.com/raminjafary/weft/commit/7ed553ff2c33eb2a773b7f20690e62a54a49fc64))
* a tutorial step is numbered work, and the rail says what you have ([05fa878](https://github.com/raminjafary/weft/commit/05fa8785d033995265a6f22399d0ff7c841b2f7b))
* a tutorial step says what it is for, and how long it takes ([aa94af7](https://github.com/raminjafary/weft/commit/aa94af73eca9eda00ba5e8272c7b9d16edac9dde))
* every guide page now opens with the mechanism, moving ([10c9311](https://github.com/raminjafary/weft/commit/10c9311629793266778d56e212a7b760a6059ed9))
* the guide index was a directory, and now it opens with the architecture ([685ef44](https://github.com/raminjafary/weft/commit/685ef440d47acd3e01d3af37fcad237cd9594934))
* the landing page had four boasts, and now it has a benchmark ([4d80ef8](https://github.com/raminjafary/weft/commit/4d80ef8527aaddce9bbe01588dc468d2390d511e))
* **weft:** an error page is a document the application may write ([d97b90f](https://github.com/raminjafary/weft/commit/d97b90f8ca3a65d2f2f232c672fdc2e6451bde99))
* the site had a stylesheet, and now it has a design system ([67b0d7e](https://github.com/raminjafary/weft/commit/67b0d7e0365bce227709f95a1dba2d2628b5fa98))
* **weft:** a component's stylesheet can be the component's ([d513b48](https://github.com/raminjafary/weft/commit/d513b483a5f49c19131efbd02fb35b8755119955))
* a table component, and the pattern the page bodies can follow ([f9d6c8a](https://github.com/raminjafary/weft/commit/f9d6c8a0fd6584763cbcd895842c99cfe9f66c90))
* **ir, compiler, client:** a hole may hold a conditional value ([7ca9daf](https://github.com/raminjafary/weft/commit/7ca9daff78727ca039ed60f1cea879baa16a04ea))
* code blocks were escaped text with no highlighting at all ([1fcd7f8](https://github.com/raminjafary/weft/commit/1fcd7f844864b0309f6ea77799c7f64439f26481))
* examples, glossary and errors had no sidebar, and two builders written for one ([bc31dd5](https://github.com/raminjafary/weft/commit/bc31dd5cb27b26d5fd4e672a20a46a9be9a482f8))
* the documentation site, which is itself a weft application ([d1e355c](https://github.com/raminjafary/weft/commit/d1e355c7fd496dd948caf6831ba5ecdfa20636ef))

### 🐛 Bug Fixes

* **weft:** an asset whose URL does not name its contents is not served immutable ([0449500](https://github.com/raminjafary/weft/commit/0449500ca78cc45b8d9292717106e3fa7f74c5b0))
* the landing page ships the run it cites ([936a6e0](https://github.com/raminjafary/weft/commit/936a6e0b46a23ab2a940163d2247aa1857ee8f98))
* **bench:** the byte budgets were measured into a terminal and nowhere else ([e127c8e](https://github.com/raminjafary/weft/commit/e127c8e187d7e6b9728a81d73ec64ab4936cd4fc))
* the search panel hung off the wrong edge ([f7863f7](https://github.com/raminjafary/weft/commit/f7863f7721a5da38a5bd5c5e3adf4ee30d85c5f3))
* the search panel covered the box you typed into ([90e1aba](https://github.com/raminjafary/weft/commit/90e1aba2f86357af61d8959d2fdd161dd42a140a))
* the theme sweep stalled on its last frame, and the fix was already written ([3f58669](https://github.com/raminjafary/weft/commit/3f5866965b0300a4c05308205584102642cd4aaa))
* a clock tick sat under the playhead, and the plain panel had no floor ([8770491](https://github.com/raminjafary/weft/commit/8770491d1a5d6501dd0a8eab0535218d688bda6e))
* the hero graphs were unstyled, oversized, and drawing invented data ([71f2ff8](https://github.com/raminjafary/weft/commit/71f2ff85cc3d7b4c3bad1d39e71cd53c99098cd8))
* the diagrams sat off-centre, and two pages had the wrong grid ([0d7f8a1](https://github.com/raminjafary/weft/commit/0d7f8a115d780f587c4c8519af5ddf817dfc9c0b))
* **kernel:** a shell was cut by a different switch from the one that renders ([94b36b2](https://github.com/raminjafary/weft/commit/94b36b2793b762009a03cf7892b260f547736d28))
* **weft:** the page painted at the top and then jumped, on every scrolled refresh ([c95429d](https://github.com/raminjafary/weft/commit/c95429d8c55cc8975fd8ed907eabc95bd5d7636c))
* the signals example was a control nobody could operate ([9f0a17d](https://github.com/raminjafary/weft/commit/9f0a17def4bb97f0b141e0f8ed2145e17267f924))
* a search threw away the query it had just run ([45e52c8](https://github.com/raminjafary/weft/commit/45e52c83ad718808f840d24b14d6a077c623043e))
* the one live control on the site rendered a literal zero ([5685d87](https://github.com/raminjafary/weft/commit/5685d8721f01380d967b9b9f21a1bd3cbccdaddb))
* **demo, inspector:** no application declared color-scheme, so every refresh began with a white frame ([3e49416](https://github.com/raminjafary/weft/commit/3e49416496d31a5beee2d7d04083cbbb3e314b5b))
* **repo:** pnpm has its own `docs` command, so the script by that name was unreachable ([8fc1bef](https://github.com/raminjafary/weft/commit/8fc1bef0c322484e203122dcb5cb64f5df1bdca3))
* **repo:** the root scripts called a binary the root did not depend on ([492ae9e](https://github.com/raminjafary/weft/commit/492ae9e4d2d686b07ec0aef4deb6db83d8ecba66))
* **spec, repo:** three published figures that had drifted, and a count I made stale myself ([b30b503](https://github.com/raminjafary/weft/commit/b30b503034afb639fcdc5008507b41d11056769f))
* every named refusal now says something, and the 8 KB path is back inside its ceiling ([b62b857](https://github.com/raminjafary/weft/commit/b62b85734e708481507938b7932e2297de1abf9a))

### ♻️ Code Refactoring

* **repo:** the scope is @weftjs, and three things a rename could break silently ([bea1027](https://github.com/raminjafary/weft/commit/bea102788a322b6f49a7cdb5a6362e6ad7161252))
* **repo:** the framework is @weft/core, because npm already serves a weft ([524705f](https://github.com/raminjafary/weft/commit/524705ff608dc75ab2cb318579d1a6f6bf6c3d34))
* the hero figures were built from a reading of the design, not the design ([e84982a](https://github.com/raminjafary/weft/commit/e84982afd8c0b59d52032170ce4ce17a7db1f8b4))
* **weft:** the errors pages are components, and static slots stopped shipping dead payloads ([3d14a88](https://github.com/raminjafary/weft/commit/3d14a8818f314de01b6b4cafa96046cf2fad296c))
* the outline columns are a component, and three copies of one `<dl>` are gone ([2599fb9](https://github.com/raminjafary/weft/commit/2599fb9493e9d119a139b2ddef0c5c9361c62e00))
* the sidebar nav is a component, not four string builders ([556afeb](https://github.com/raminjafary/weft/commit/556afeb8612aa615d2d072dd0ed9890f577bc0b2))

### 📝 Documentation

* **weft:** the measuring page describes a profile without showing one ([4805122](https://github.com/raminjafary/weft/commit/48051227d5e4066629435066722cf78df8b5898e))
* **spec:** the nine pages the guide was missing, and coverage as a gate rather than a claim ([deb3b14](https://github.com/raminjafary/weft/commit/deb3b145fe2c55a04709609d706d786ffe92ae56))
* **repo:** the roadmap is one item, and it needs hardware rather than code ([e2e9671](https://github.com/raminjafary/weft/commit/e2e96717e6298723c8915a0d6c6322003a6df920))
* **repo:** every export in the framework has a doc comment, and that is now a gate ([c77a1c0](https://github.com/raminjafary/weft/commit/c77a1c011e8d13a18c0e77b45ee8b55a84d89df1))

### ✅ Testing

* **weft, plan:** the three warnings that fired and nothing asserted ([5d8ae7b](https://github.com/raminjafary/weft/commit/5d8ae7bd6a416abc9b25bcbde635b8bdf1b44d64))

### 📦 Build & Dependencies

* **repo:** a release is one command, and every version it writes comes from the commits ([c949c45](https://github.com/raminjafary/weft/commit/c949c458b7bf4a012014498a0cf37e493dc42fef))

### 🚚 Chores

* **repo:** the byte budgets the merged tree measures, and the inspector's first one ([e478c68](https://github.com/raminjafary/weft/commit/e478c680aaa201dde492eb60fb716205da55476d))
* **repo:** the byte budgets record what this round of fixes cost ([0a447ea](https://github.com/raminjafary/weft/commit/0a447ea64a39685724af730d1d7b4b6a51065576))
