import { cpuUsage } from 'node:process'
import { parentPort, workerData } from 'node:worker_threads'

/**
 * The other side of the pool. It resolves a module and an export by name and calls it, which
 * is the whole reason `JobAddress` exists: nothing here can receive a closure.
 *
 * `parentPort.postMessage` is a MessagePort post: it takes a transfer list, not a target
 * origin, which is why `unicorn/require-post-message-target-origin` is off for this file.
 *
 * One job at a time, on purpose. A worker running two renders has two renders to lose when the
 * parent terminates it for exceeding a budget, and a CPU budget that kills a bystander is not
 * a budget, it is an outage with a stack trace.
 */
interface Request {
  id: number
  module: string
  export?: string
  props?: unknown
  /**
   * Load the module and say nothing else.
   *
   * The parent asks for this before it starts a budget clock: importing is CPU, and a first render
   * charged for its own import would make a cold worker's budget a different budget from every one
   * after it. One round trip per module per worker, and only when a budget is set.
   */
  preload?: boolean
}

type Renderer = (props?: unknown) => Uint8Array | string | Promise<Uint8Array | string>

const utf8 = new TextEncoder()
const loaded = new Map<string, Promise<Record<string, unknown>>>()
const root = (workerData as { root?: string } | undefined)?.root ?? ''

function load(module: string): Promise<Record<string, unknown>> {
  let pending = loaded.get(module)
  if (!pending) {
    // Cached per worker, so the second job against a module pays nothing. This is also why a
    // pool is warm and an isolate-per-render is not.
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
      /**
       * CPU rather than wall clock, and it is only measurable here.
       *
       * One job at a time on this thread means a `cpuUsage` delta around the render is that
       * render's and nothing else's — which is not true on the request thread, where several
       * renders and the stream interleave. `user + system`, because a render that spends its
       * time in a syscall spent it.
       */
      /**
       * "The render is starting", which is what the parent's budget has to be measured from.
       *
       * The first job against a module pays for importing it, and importing is CPU. Charging that
       * to the render would make a cold worker's first budget a different budget from every one
       * after it — and "a pool is warm" is the whole reason to pay for a thread. So the parent
       * re-baselines here, one message per job, and what it then measures is the renderer.
       */
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
