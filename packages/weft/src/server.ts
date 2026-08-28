/**
 * The framework's server surface: everything `weft dev`, `weft build` and `weft start` are made
 * of, exported so a deployment that needs its own entry point can build one.
 *
 * An application does not import this. It exists because a framework whose only entry point is a
 * CLI is a framework you cannot embed, and because the CLI itself should have no privileged
 * access to anything an application could not reach.
 */
export {
  appHandler,
  bootPrelude,
  createApp,
  serveApp,
  serveHandler,
  type App,
  type CreateOptions,
  type Handler,
  type Mode,
  type Serving,
} from './serve.ts'
export { startHandler } from './start.ts'
export { build, loadBuild, formatReport, type BuildReport, type IrManifest } from './build.ts'
export { dev, type DevServer } from './dev.ts'
export {
  chainFor,
  discover,
  patternOf,
  ConventionError,
  type Discovered,
  type DiscoveredNested,
  type DiscoveredRoute,
} from './convention.ts'
export {
  compileApp,
  frameworkStyles,
  scopedSheets,
  slotHoles,
  type CompiledApp,
  type CompiledFragment,
} from './compile.ts'
export { isScopedSheet, scopeAttribute, scopeCss, scopeStem } from './scoped.ts'
/**
 * Exported for the benchmark harness, which cross-checks it against the running server.
 *
 * This is the function `budget({ js, grow })` is enforced against — a walk over files on disk. That
 * it agrees with what a browser receives is a claim the specification makes, and a claim needs
 * something able to check it.
 */
export { measureClientJs, type JsMeasurement } from './js-budget.ts'
export { generateRoutes, navOf, GenerateError, type Generated, type GeneratedRoute } from './routes.ts'
export { loadIntents, moduleIdOf, type IntentManifest, type ManifestEntry } from './intents.ts'
export { loadConfig, type ResolvedConfig } from './config.ts'
export {
  buildAssets,
  browserModule,
  cacheControl,
  cacheControlFor,
  moduleFiles,
  revAssets,
  rewriteUrls,
  type Asset,
  type AssetTable,
  type ModuleTree,
  type RevvedAssets,
} from './assets.ts'
export { scaffold, type Scaffolded, type ScaffoldOptions, type Template } from './scaffold.ts'
export {
  loadDocuments,
  prerender,
  staticVerdict,
  STATIC_DIR,
  type Prerendered,
  type ServedDocument,
  type StaticDocument,
  type StaticManifest,
  type StaticRefusal,
  type StaticVerdict,
} from './static.ts'
export { devtoolsFor, DEVTOOLS_PATH, type DevtoolsHandler } from './devtools.ts'
export { siteObjects, writeSite, type SiteObject, type SiteReport } from './site.ts'
