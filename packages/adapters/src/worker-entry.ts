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
  export: string
  props?: unknown
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
      const renderer = exports[request.export]
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
