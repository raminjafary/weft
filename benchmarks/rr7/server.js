import { createServer } from 'node:http'
import { createElement as h } from 'react'
import { renderToPipeableStream } from 'react-dom/server'
import { createStaticHandler, createStaticRouter, StaticRouterProvider, useLoaderData } from 'react-router'
import { Lines, makeRows, sleep } from './app.js'

const PORT = Number(process.env.PORT ?? 0)
const MODE = process.env.MODE === 'blocking' ? 'blocking' : 'stream'
const DELAY = Number(process.env.DELAY ?? 40)
const ROWS = Number(process.env.ROWS ?? 50)
const SEED = Number(process.env.SEED ?? seedOf('slow-feed'))

function seedOf(id) {
  return [...id].reduce((acc, c) => acc * 31 + c.charCodeAt(0), 7919)
}

async function loadRows() {
  if (DELAY > 0) await sleep(DELAY)
  return makeRows(ROWS, SEED)
}

const routes = [
  {
    id: 'feed',
    path: '/feed',
    async loader() {
      // Streaming mode hands the router an unresolved promise, so the shell is not
      // downstream of the query. Blocking mode awaits it, which is the default shape.
      return MODE === 'stream' ? { epoch: 'e7', total: 12000, rows: loadRows() } : { epoch: 'e7', total: 12000, rows: await loadRows() }
    },
    Component: function Feed() {
      const data = useLoaderData()
      return h(Lines, { ...data, streaming: MODE === 'stream' })
    },
  },
]

const handler = createStaticHandler(routes)

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
  const request = new Request(url, { method: req.method, headers: new Headers(Object.entries(req.headers).filter(([, v]) => typeof v === 'string')) })

  try {
    const context = await handler.query(request)
    if (context instanceof Response) {
      res.writeHead(context.status, Object.fromEntries(context.headers))
      res.end(await context.text())
      return
    }
    const router = createStaticRouter(routes, context)
    const element = h(StaticRouterProvider, { router, context, hydrate: false })

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    const stream = renderToPipeableStream(element, {
      onShellReady() {
        if (MODE === 'stream') stream.pipe(res)
      },
      onAllReady() {
        if (MODE === 'blocking') stream.pipe(res)
      },
      onError(error) {
        process.stderr.write(`${error}\n`)
      },
    })
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end(String(error))
  }
})

server.listen(PORT, '127.0.0.1', () => {
  const address = server.address()
  process.stdout.write(`rr7 ${MODE} listening on http://127.0.0.1:${address.port} (delay ${DELAY}ms, rows ${ROWS})\n`)
})
