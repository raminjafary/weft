import { watch } from 'node:fs'
import type { WeftConfig } from './config.ts'
import { createApp, serveApp, type Serving } from './serve.ts'

/**
 * `weft dev`: serve, and rebuild what changed.
 *
 * Two kinds of change, because they are genuinely different and pretending otherwise makes one of
 * them silently not work.
 *
 * A `.tsx` or a `.css` is **data**: the framework reads it, compiles or concatenates it, and holds
 * the result. Rebuilding it in place is exact, and it keeps what a restart would throw away — the
 * store's entries, open channels, and a page that is mid-delta.
 *
 * A `.ts` is **code**, and code that has been imported cannot be un-imported. ESM has no cache to
 * invalidate: re-importing a loader returns the module from the first time, and its own imports are
 * cached a level deeper still, so nothing short of a new process picks up an edited helper. So a
 * `.ts` change asks for a restart, and `weft dev` runs a supervisor that gives it one.
 *
 * The alternative — busting the cache with a query string on the entry module — reloads the file
 * you edited and none of the files it imports, which is worse than not reloading at all: it works
 * often enough to be trusted and fails silently the rest of the time.
 */
export interface DevServer {
  url: string
  /**
   * What this deployment bound that will not do what it says — an intent whose capability nothing
   * grants, a signature nothing can check, a replay window narrower than the deployment.
   *
   * Surfaced here because `weft dev` is where somebody can act on it. Every one of these is also a
   * named refusal at request time, and a 501 during a demo is a bad way to learn that a config file
   * is missing a line.
   */
  warnings: string[]
  close(): Promise<void>
}

export interface ReloadEvent {
  file: string
  ms: number
  /** `restart` means the process is about to exit so a supervisor can replace it. */
  kind: 'rebuild' | 'restart'
  error?: Error
}

/** Exit code the supervisor reads as "start me again". Anything else is a real exit. */
export const RESTART_CODE = 75

const IGNORED = /(^|[\\/])(\.weft|node_modules|\.git|dist|\.DS_Store)([\\/]|$)/
/** A change the framework can absorb without a new module graph. */
const DATA = /\.(tsx|css|json|svg|png|jpg|jpeg|webp|avif|gif|ico|woff2?|txt|xml)$/

export async function dev(
  root: string,
  overrides: WeftConfig = {},
  onReload?: (event: ReloadEvent) => void,
): Promise<DevServer> {
  let serving: Serving = await serveApp(await createApp(root, { ...overrides, mode: 'dev' }))
  let queued: NodeJS.Timeout | null = null
  let closing = false

  const rebuild = async (file: string): Promise<void> => {
    const started = Date.now()
    try {
      // The port has to come back, so the old server closes before the new one binds. A dev
      // server that races itself for its own port fails every tenth save.
      const port = Number(new URL(serving.url).port)
      await serving.close()
      serving = await serveApp(await createApp(root, { ...overrides, mode: 'dev', port }))
      onReload?.({ file, ms: Date.now() - started, kind: 'rebuild' })
    } catch (error) {
      // A broken save must not take the server down: the next save is usually the fix, and a dev
      // server that exits on a syntax error is one you restart by hand all day.
      onReload?.({ file, ms: Date.now() - started, kind: 'rebuild', error: error as Error })
    }
  }

  const watcher = watch(root, { recursive: true }, (_event, name) => {
    if (closing || !name || IGNORED.test(name)) return
    if (!DATA.test(name)) {
      // Code. Hand back to the supervisor rather than reload something that would not take.
      closing = true
      watcher.close()
      onReload?.({ file: name, ms: 0, kind: 'restart' })
      void serving.close().then(() => process.exit(RESTART_CODE))
      return
    }
    if (queued) clearTimeout(queued)
    // One rebuild per burst: an editor writing a file emits several events, and a formatter on
    // save emits several more.
    queued = setTimeout(() => void rebuild(name), 40)
  })

  return {
    get url() {
      return serving.url
    },
    get warnings() {
      return serving.app.authority.diagnostics
    },
    close: async () => {
      closing = true
      if (queued) clearTimeout(queued)
      watcher.close()
      await serving.close()
    },
  }
}
