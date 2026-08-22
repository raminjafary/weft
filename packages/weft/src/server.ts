/**
 * The framework's server surface: everything `weft dev`, `weft build` and `weft start` are made
 * of, exported so a deployment that needs its own entry point can build one.
 *
 * An application does not import this. It exists because a framework whose only entry point is a
 * CLI is a framework you cannot embed, and because the CLI itself should have no privileged
 * access to anything an application could not reach.
 */
export { createApp, serveApp, type App, type CreateOptions, type Mode, type Serving } from './serve.ts'
export { build, loadBuild, formatReport, type BuildReport, type IrManifest } from './build.ts'
export { dev, type DevServer } from './dev.ts'
export { discover, patternOf, ConventionError, type Discovered, type DiscoveredRoute } from './convention.ts'
export { compileApp, frameworkStyles, slotHoles, type CompiledApp, type CompiledFragment } from './compile.ts'
export { generateRoutes, navOf, GenerateError, type Generated, type GeneratedRoute } from './routes.ts'
export { loadIntents, moduleIdOf, type IntentManifest, type ManifestEntry } from './intents.ts'
export { loadConfig, type ResolvedConfig } from './config.ts'
export { buildAssets, browserModule, cacheControlFor, type Asset, type AssetTable } from './assets.ts'
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
