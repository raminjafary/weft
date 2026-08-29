import { cpuUsage } from 'node:process'
import { parentPort, workerData } from 'node:worker_threads'

/**
 * The other side of the pool. Resolves a module and export by name and calls it — nothing here
 * can receive a closure. One job at a time: a worker running two renders has two to lose when
 * terminated for one budget breach.
 */
interface Request {
  id: number
  module: string
  export?: string
  props?: unknown
  /** Load the module and say nothing else. Asked before the budget clock starts. See `spec/kernel/locus.md`. */
  preload?: boolean
}

type Renderer = (props?: unknown) => Uint8Array | string | Promise<Uint8Array | string>

const utf8 = new TextEncoder()
const loaded = new Map<string, Promise<Record<string, unknown>>>()
const root = (workerData as { root?: string } | undefined)?.root ?? ''

function load(module: string): Promise<Record<string, unknown>> {
  let pending = loaded.get(module)
  if (!pending) {
    // Cached per worker, so the second job against a module pays nothing.
    pending = import(module.startsWith('.') ? new URL(module, root).href : module) as Promise<
      Record<string, unknown>
    >
    loaded.set(module, pending)
  }
  return pending
}

parentPort?.on('message', (request: Request) => {
  void (async () => {
    try {
      const exports = await load(request.module)
      if (request.preload) {
        parentPort?.postMessage({ id: request.id, phase: 'loaded' })
        return
      }
      const renderer = exports[request.export as string]
      if (typeof renderer !== 'function') {
        throw new Error(`E_NO_SUCH_EXPORT: ${request.module} has no callable export ${request.export}`)
      }
      // CPU rather than wall clock, measurable only here: one job at a time means a `cpuUsage`
      // delta around the render is that render's alone. "The render is starting" lets the parent
      // re-baseline before measuring it. See `spec/kernel/locus.md`.
      parentPort?.postMessage({ id: request.id, phase: 'render' })
      const before = cpuUsage()
      const result = await (renderer as Renderer)(request.props)
      const spent = cpuUsage(before)
      const bytes = typeof result === 'string' ? utf8.encode(result) : result
      parentPort?.postMessage({ id: request.id, bytes, cpuMs: (spent.user + spent.system) / 1000 }, [
        bytes.buffer as ArrayBuffer,
      ])
    } catch (error) {
      parentPort?.postMessage({
        id: request.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })()
})
