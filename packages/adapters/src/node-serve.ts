import { Readable } from 'node:stream'
import { createServer, type Server } from 'node:http'
import { fillerBytes, type Order, type Route, type SlotContent, streamRoute } from '@weft/kernel'

export interface ServeOptions {
  order: Order
  prelude?: SlotContent
  postlude?: SlotContent
}

export interface Serving {
  url: string
  close(): Promise<void>
}

/**
 * A route, served. Headers and the shell go out before any slot is awaited, which is the
 * only property here that matters: a slow region cannot delay the first byte.
 */
export async function serveRoute(route: Route, options: ServeOptions, path = '/'): Promise<Serving> {
  const server: Server = createServer((req, res) => {
    if ((req.url ?? '/').split('?')[0] !== path) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    })
    const stream = streamRoute(route, {
      order: options.order,
      ...(options.prelude ? { prelude: options.prelude } : {}),
      ...(options.postlude ? { postlude: options.postlude } : {}),
      // The filler is the default now, because a fill that references an undefined function is
      // not a degradation. Left here only to show that it can be replaced.
      ...(options.order === 'out-of-order' ? { filler: fillerBytes() } : {}),
    })
    Readable.fromWeb(stream as never).pipe(res)
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
