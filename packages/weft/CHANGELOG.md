# Changelog

Every commit in this repository appears here, not only `feat` and `fix`. The sections are
generated from Conventional Commit types by `scripts/release/`, and a package changelog holds
the commits scoped to that package.

## [0.2.2](https://github.com/raminjafary/weft/compare/v0.2.1...HEAD) (2026-08-28)

### ✅ Testing

* the repeated-preamble test pinned a close code that races the teardown ([3134f48](https://github.com/raminjafary/weft/commit/3134f482036fa20085ab8acaf2d2c890e0d22be9))

## [0.2.1](https://github.com/raminjafary/weft/compare/v0.2.0...v0.2.1) (2026-08-28)

### ✨ Features

* **bench:** the walk over HTTP is a command, so the cross-check can be re-run ([55d4979](https://github.com/raminjafary/weft/commit/55d4979798aabf47c7c2696e3667318c6dcc8949))

### 🐛 Bug Fixes

* a report whose lines are not lines, a document count that counted files, and two scaffold gaps ([1fe6151](https://github.com/raminjafary/weft/commit/1fe6151446a6b6c38136e8ef82204be7961a0b9e))
* a page an intent invalidates was frozen into a file nothing can invalidate ([0848c76](https://github.com/raminjafary/weft/commit/0848c761de45af3fe4eeefe4f96527b14317af9f))
* the client announced its version on every message, so a live page's buttons did nothing ([72955c7](https://github.com/raminjafary/weft/commit/72955c771ae25481061dacb36ec5804565a2171a))
* **repo:** the navigation table has both its columns, and the download figure is checkable ([f909a40](https://github.com/raminjafary/weft/commit/f909a404c5961c9a725b7864ac58f0f19b648f09))

## [0.2.0](https://github.com/raminjafary/weft/compare/v0.1.1...v0.2.0) (2026-08-28)

### ✨ Features

* a sitemap generated from what was published, and a canonical URL per route ([00472df](https://github.com/raminjafary/weft/commit/00472df756b1f62666b4cc1792bf975a0672f21f))
* **kernel:** a channel binding that holds nothing, so a host with no process can carry one ([559eb88](https://github.com/raminjafary/weft/commit/559eb88431646d0e37f993ba58157727814d1455))

### 🐛 Bug Fixes

* **repo:** every number in every document, re-measured against the run that shipped with it ([6a4ff00](https://github.com/raminjafary/weft/commit/6a4ff00d6d72bb1e585c92443528076eed12fd1a))
* a relative root filled the asset map with keys nothing could look up ([ff66cb1](https://github.com/raminjafary/weft/commit/ff66cb17114a4a48eb8828b4d93a736f44658f78))
* **repo:** every document quoting a measured size quotes the one that was measured ([b57b884](https://github.com/raminjafary/weft/commit/b57b8847c3fa1dac1e56b05c5db58339e17a38d6))
* a slow route no longer paints over the one you clicked after it ([385c9de](https://github.com/raminjafary/weft/commit/385c9dea9e7cc5bdd39bae63b551cb282ffb2983))
* a port a browser refuses is a channel that never connects and never says so ([f8d8080](https://github.com/raminjafary/weft/commit/f8d808020729b6851dd32d29af0d32382ed772bd))

### ⚡️ Performance Improvements

* weft start transforms a module once, not once per request ([c0d1106](https://github.com/raminjafary/weft/commit/c0d11062a3ff4f99fedc6f92d218834aeef21207))
* a document names the modules it will fetch, so they stop arriving one hop at a time ([bc263cd](https://github.com/raminjafary/weft/commit/bc263cdcf243dd742c4283faf0d80a88f1cc2f67))
* a production build stops shipping its own documentation ([37e803b](https://github.com/raminjafary/weft/commit/37e803b2408269a8218f790008d0deae3c25b6b1))

### 📝 Documentation

* **kernel:** every field a declaration has says what it is ([175218c](https://github.com/raminjafary/weft/commit/175218c8257940a6b0717b31933f615f4c6cdcc1))

## [0.1.1](https://github.com/raminjafary/weft/compare/v0.1.0...v0.1.1) (2026-08-28)

### 🐛 Bug Fixes

* **repo:** five map spreads become the thing they were spreading for, and the rule goes off ([6fb5ad8](https://github.com/raminjafary/weft/commit/6fb5ad812541986b9110e9ec1147ac3c00706e98))
* a client module is served at a .js URL, whatever the source extension is ([bffbf1f](https://github.com/raminjafary/weft/commit/bffbf1ff77640a4dae767cf02acc85de4a8f9a8d))

## 0.1.0 (2026-08-28)

### ✨ Features

* **repo:** the docs site, the demo and a new application all use both asset directories ([b2516af](https://github.com/raminjafary/weft/commit/b2516af07176ee11815a08b2cf4d75bb612f4527))
* app/assets is processed, public is copied ([2a1b90e](https://github.com/raminjafary/weft/commit/2a1b90ef40ef5f71233b74801689ef27ac785c70))
* `weft site` writes the build as a folder a static host can serve ([6d040db](https://github.com/raminjafary/weft/commit/6d040db3522dccc4077b3f1387b505b3adfd37f4))
* a shared cache may answer with a document the build proved invariant ([4cf5f4a](https://github.com/raminjafary/weft/commit/4cf5f4a9a03b6b7cf7423cefa47df7ed8b0c164f))
* a host that owns the socket can serve the application without one ([702c52b](https://github.com/raminjafary/weft/commit/702c52b483a0d79f52e956d064023c4a9f76cc56))
* an error page is a document the application may write ([d97b90f](https://github.com/raminjafary/weft/commit/d97b90f8ca3a65d2f2f232c672fdc2e6451bde99))
* **docs:** the site had a stylesheet, and now it has a design system ([67b0d7e](https://github.com/raminjafary/weft/commit/67b0d7e0365bce227709f95a1dba2d2628b5fa98))
* a component's stylesheet can be the component's ([d513b48](https://github.com/raminjafary/weft/commit/d513b483a5f49c19131efbd02fb35b8755119955))
* **client:** the staging decision the profile measured and nobody read ([732b9bf](https://github.com/raminjafary/weft/commit/732b9bf3394b52ab75e2d17ee983e316b18ba1ab))
* a page that declares it is not a file, and says why ([ad276f1](https://github.com/raminjafary/weft/commit/ad276f19f764e8e4873e2bc8a2bdf2137ddb1216))
* **kernel, plan, demo:** a document that is a chain of layouts, checked as one document ([b18573f](https://github.com/raminjafary/weft/commit/b18573f2ba9663f523b0480407c1e5d8e475151e))
* **warp, kernel, adapters:** the socket a channel is for, the downgrades in traffic, and Workers ([7182f5b](https://github.com/raminjafary/weft/commit/7182f5b193a79790e7b35222b43f7e9ccbd46fda))
* **kernel:** invalidation crosses a tier boundary, and what crosses it is authority ([742b3cc](https://github.com/raminjafary/weft/commit/742b3cc79ba782719ce5c1c76ef1b638ca6b9bf3))
* a file per URL when the URLs are a set somebody declared, and a way to upload them ([31c321c](https://github.com/raminjafary/weft/commit/31c321c0ce5289f9910f6b855eb391d0fc3f7061))
* **kernel, plan:** four plan declarations that were recorded and read by nothing ([24227f2](https://github.com/raminjafary/weft/commit/24227f2b0aa0a48c68a693111f3555e4cfdc82a4))
* **kernel, adapters:** the two HTTP derivations the cache spec was missing ([a2c2b4b](https://github.com/raminjafary/weft/commit/a2c2b4ba65e9bc4fd26ecc6b1cfc2e01b710cc45))
* **ir, kernel, client:** the rung the surgical ladder was missing, and what a list taught it ([0d1590a](https://github.com/raminjafary/weft/commit/0d1590a58a6aa827385b11904e855592ba640f31))
* **kernel:** a composite says what it is made of, and the request path pays nothing for it ([b0c3aae](https://github.com/raminjafary/weft/commit/b0c3aaea812b1f01bbd37602c3679b2b5150bfd3))
* **adapters:** the lease that was described and not shipped, and what a test can honestly say ([b2fc1e1](https://github.com/raminjafary/weft/commit/b2fc1e1f402d7310fd3c575ec2751bac1588e35d))
* **kernel:** the seams phase seven and nine left open, and the field that was answering two questions ([07f9dd4](https://github.com/raminjafary/weft/commit/07f9dd42edc7b54c20b6a7a50ae91a09d78d621f))
* **kernel:** who may run an intent, whether this deployment issued it, and a plan a client can ask for ([bdfcbd7](https://github.com/raminjafary/weft/commit/bdfcbd7d0947f03d2bbbc56a77e3ea460cec59c7))
* **kernel:** WARM stages a route, NAV answers, and a delta arrives for a page nobody has visited ([5228137](https://github.com/raminjafary/weft/commit/5228137bfeac493ca124ad06556dce88d768d050))
* a plan generated from what the renders actually cost ([3913ddd](https://github.com/raminjafary/weft/commit/3913ddd01f01bd47f8e3f847ad9766c251074977))
* three signals for the readers who cannot hover ([54e7076](https://github.com/raminjafary/weft/commit/54e7076f98c628c9670a392d6f8c90f73860d3d0))
* **kernel:** the six ports that were declared and had nothing behind them ([215312a](https://github.com/raminjafary/weft/commit/215312ab796f33712fcac0dba5d4eee937f3b4f6))
* a link the framework answers itself, and what that is allowed to cost ([b4912f6](https://github.com/raminjafary/weft/commit/b4912f6d782e23bc5745f1f14f3a52090fb1c837))
* a navigation the framework caused is not a navigation ([31f061b](https://github.com/raminjafary/weft/commit/31f061b19dbbe5c5cc8f3dda79942bd6bd78350b))
* where you were, across a navigation the framework caused ([f1b40de](https://github.com/raminjafary/weft/commit/f1b40deb88e13fba11f68015edd9712c4735e80d))
* a page that reads nothing is a file ([8d89bd2](https://github.com/raminjafary/weft/commit/8d89bd24625ceaa059994f6ce57eab22356ce020))
* devtools, which is the framework pointed at your application ([10575f2](https://github.com/raminjafary/weft/commit/10575f2ea6eac88f0678fb9601d549ceeffd7344))
* controls, runtime readouts and a refresh the framework wires itself ([947a4b3](https://github.com/raminjafary/weft/commit/947a4b353197c4402f1b38822f6a39644c63ffbf))
* a folder is an application — weft dev, build, start and create ([2aff8e8](https://github.com/raminjafary/weft/commit/2aff8e85db6047014c7356082d76cea2f7a06e48))

### 🐛 Bug Fixes

* clicking the page you are already on does nothing, rather than reloading it ([b393c1a](https://github.com/raminjafary/weft/commit/b393c1afdd38e0c7aff6338f3a48fcd3b5258dda))
* a request whose body the host already read is answered, not waited on ([9310933](https://github.com/raminjafary/weft/commit/93109335fa1ad34ce13f96b27d2d8f31965d5cea))
* an asset whose URL does not name its contents is not served immutable ([0449500](https://github.com/raminjafary/weft/commit/0449500ca78cc45b8d9292717106e3fa7f74c5b0))
* the build writes the modules its own manifest names ([ef14219](https://github.com/raminjafary/weft/commit/ef142194d4584fea09bbf13b6d47d0efd79ac3e4))
* a click on a route being staged waits for it instead of discarding it ([13fce20](https://github.com/raminjafary/weft/commit/13fce2075d9931b06b974c23baa742a87b1f13d8))
* a revved asset says the one thing a CDN actually reads ([347816d](https://github.com/raminjafary/weft/commit/347816d7aaf767718147d15bbc2c64b5b0be8234))
* the `weft` command exists before the build that writes it ([8699391](https://github.com/raminjafary/weft/commit/86993913a0e5c627ebb0400bc44b69e80c255f94))
* **kernel:** a shell was cut by a different switch from the one that renders ([94b36b2](https://github.com/raminjafary/weft/commit/94b36b2793b762009a03cf7892b260f547736d28))
* the page painted at the top and then jumped, on every scrolled refresh ([c95429d](https://github.com/raminjafary/weft/commit/c95429d8c55cc8975fd8ed907eabc95bd5d7636c))
* dev forbade the client from keeping an asset, so every reload repainted unstyled ([fe65c93](https://github.com/raminjafary/weft/commit/fe65c935845118a9a7e57553be6fb1f246558f50))
* every named refusal now says something, and the 8 KB path is back inside its ceiling ([b62b857](https://github.com/raminjafary/weft/commit/b62b85734e708481507938b7932e2297de1abf9a))
* the framework's own assets are staged through a rename, so two builds cannot read half of one ([9793674](https://github.com/raminjafary/weft/commit/97936745cedd8520a3040f309a8e9677a9b80ab6))
* a route param is part of what a slot on a generated route is ([076aec6](https://github.com/raminjafary/weft/commit/076aec6662c329cde64106386d7bdc046da7f227))
* the nav entry for a parameterised page is never the page you are on ([be47f38](https://github.com/raminjafary/weft/commit/be47f381b4f73969725c9a32f5d5d31f371050a4))
* three things that only break when you run the build ([993b748](https://github.com/raminjafary/weft/commit/993b748d7689c5b1206dfb41bd7ff8f6d01b6dd9))
* **ir:** a raw value hole cannot serve a delta ([cfa8f2d](https://github.com/raminjafary/weft/commit/cfa8f2d6478a1dee39ebea50196c523b42bf7cbb))
* **kernel:** a slot that fails ends the response instead of hanging it ([7e76470](https://github.com/raminjafary/weft/commit/7e764705aeb1e688457aa632411020e3b24c0076))
* **compiler:** an intent id names where the intent lives, not where it was imported from ([cf3c1ad](https://github.com/raminjafary/weft/commit/cf3c1ade0d318063477660750dabf967f9b093af))
* a slot is a cached thing per route, and the demo's shim is gone ([3b737ea](https://github.com/raminjafary/weft/commit/3b737eac2996d49c0fab9e45c8cf27d29b6036df))

### ♻️ Code Refactoring

* **repo:** the scope is @weftjs, and three things a rename could break silently ([bea1027](https://github.com/raminjafary/weft/commit/bea102788a322b6f49a7cdb5a6362e6ad7161252))
* each generated URL root is the initial of what is behind it ([f5be654](https://github.com/raminjafary/weft/commit/f5be654d07455402b307cb88d1c0add500054807))
* **repo:** the framework is @weft/core, because npm already serves a weft ([524705f](https://github.com/raminjafary/weft/commit/524705ff608dc75ab2cb318579d1a6f6bf6c3d34))
* **docs:** the errors pages are components, and static slots stopped shipping dead payloads ([3d14a88](https://github.com/raminjafary/weft/commit/3d14a8818f314de01b6b4cafa96046cf2fad296c))

### 📝 Documentation

* **repo:** ten packages declare a README in `files`, and none of them had one ([6a7d97c](https://github.com/raminjafary/weft/commit/6a7d97c7a73a0df9d790e36d2e4627136a863829))
* **docs:** the measuring page describes a profile without showing one ([4805122](https://github.com/raminjafary/weft/commit/48051227d5e4066629435066722cf78df8b5898e))
* **repo:** every export in the framework has a doc comment, and that is now a gate ([c77a1c0](https://github.com/raminjafary/weft/commit/c77a1c011e8d13a18c0e77b45ee8b55a84d89df1))
* **kernel, client, ir, plan:** another 88 exports documented ([6b1b988](https://github.com/raminjafary/weft/commit/6b1b988b929112c03b10cbac920923ccc261f2c6))

### ✅ Testing

* **plan:** the three warnings that fired and nothing asserted ([5d8ae7b](https://github.com/raminjafary/weft/commit/5d8ae7bd6a416abc9b25bcbde635b8bdf1b44d64))

### 📦 Build & Dependencies

* **repo:** a release is one command, and every version it writes comes from the commits ([c949c45](https://github.com/raminjafary/weft/commit/c949c458b7bf4a012014498a0cf37e493dc42fef))
* **deps:** Pin dependencies ([a678dfe](https://github.com/raminjafary/weft/commit/a678dfe7461c41ebc8d7c6a2bb626ca2aa5faf18))

### 🚚 Chores

* **repo:** the merge's byte budget, and the twelve new commits in the changelogs ([676f741](https://github.com/raminjafary/weft/commit/676f741e09f8e1bdc972ad12dc7870f255dbac88))
