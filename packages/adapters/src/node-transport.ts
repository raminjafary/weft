import { Readable } from 'node:stream'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  type Kernel,
  type KernelRoute,
  linkValue,
  type PreloadLink,
  type TransportPort,
} from '@weftjs/kernel'

/** Request in, Response out — the whole of running the kernel on Node. See `spec/kernel/lifecycle.md` for 103 Early Hints. */
export function nodeTransport(res: ServerResponse): TransportPort {
  return {
    name: 'node-http',
    earlyHints(links: PreloadLink[]) {
      if (!links.length) return false
      const writer = (res as ServerResponse & { writeEarlyHints?: (hints: { link: string[] }) => void })
        .writeEarlyHints
      if (typeof writer !== 'function') return false
      // An array, not a comma-joined string: Node rejects the joined form outright.
      writer.call(res, { link: links.map(linkValue) })
      return true
    },
  }
}

/** What mounting needs: the kernel, the port, and the handlers around it. */
export interface MountOptions {
  path?: string
  /** Built per request, so the transport can hold the response object it must write 103 to. */
  kernel(transport: TransportPort): Kernel
  route(): KernelRoute
}

/** A mounted kernel: the server, the URL it answers on, and how to close it. */
export interface Mounted {
  url: string
  close(): Promise<void>
}

/** A kernel on a Node HTTP server. The one place web-standard Request meets `node:http`. */
export async function mountKernel(options: MountOptions): Promise<Mounted> {
  const path = options.path ?? '/'
  const server: Server = createServer((req, res) => {
    void serve(req, res, path, options)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address === 'string' || address === null)
    throw new Error(
      'E_NO_ADDRESS: the server reported no TCP address after listening, so nothing can be told where to connect',
    )
  return {
    url: `http://127.0.0.1:${address.port}${path}`,
    close: () =>
      new Promise<void>((resolve) => {
        // A keep-alive socket keeps `close` pending forever, so idle connections are dropped
        // first. A close that does not close is not a close.
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

async function serve(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  options: MountOptions,
): Promise<void> {
  if ((req.url ?? '/').split('?')[0] !== path) {
    res.writeHead(404)
    res.end()
    return
  }
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(key, value)
    else if (Array.isArray(value)) for (const v of value) headers.append(key, v)
  }

  const kernel = options.kernel(nodeTransport(res))
  const response = await kernel.handle(
    new Request(url, { method: req.method ?? 'GET', headers }),
    options.route(),
  )

  const out: Record<string, string | string[]> = {}
  for (const [key, value] of response.headers) {
    // set-cookie is the one header that legitimately repeats.
    out[key] = key === 'set-cookie' ? response.headers.getSetCookie() : value
  }
  res.writeHead(response.status, out)
  if (!response.body) {
    res.end()
    return
  }
  Readable.fromWeb(response.body as never).pipe(res)
}
