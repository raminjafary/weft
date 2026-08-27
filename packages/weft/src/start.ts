import { loadBuild } from './build.ts'
import { loadConfig, type WeftConfig } from './config.ts'
import { discover } from './convention.ts'
import { appHandler, createApp, type Handler } from './serve.ts'

/**
 * `weft start`, up to the point where something listens.
 *
 * The whole of the start path is here — load the config, discover the tree, load the sealed
 * templates the build wrote, bind the ports — and none of the socket is. The CLI puts the result on
 * a TCP port; a platform that owns the socket calls the handler directly. No compiler runs either
 * way, which is the property `weft start` exists to have: a deployment serves the templates that
 * were reviewed, not templates it produced again from source that may have moved underneath it.
 *
 * It is deliberately a whole-application boot rather than a per-request one. Reading ninety sealed
 * templates and three hundred prerendered documents is work with a fixed answer, so a host that
 * reuses a process pays for it once and every request after that is served from memory.
 */
export async function startHandler(root: string, overrides: WeftConfig = {}): Promise<Handler> {
  const config = await loadConfig(root, overrides)
  const discovered = await discover(root, config.srcDir)
  const compiled = await loadBuild(discovered, config)
  return appHandler(await createApp(root, { ...overrides, mode: 'start', compiled }))
}
