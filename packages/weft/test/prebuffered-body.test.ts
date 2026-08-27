import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { appHandler, createApp, type Handler } from '../src/serve.ts'

/**
 * A host that read the request before handing it over.
 *
 * Every serverless platform with a body parser does this: it consumes the request stream to give
 * the handler a parsed `req.body`, and what reaches the framework is a stream that will never emit
 * another byte and never emit `end`. Reading it then does not fail — it waits, until the platform's
 * own timeout ends the request. On the documentation deployment that was every `POST`: intents,
 * the token endpoint, and a 404 alike, all 504 after thirty seconds, while the same requests
 * answered locally in ten milliseconds.
 *
 * That difference is the whole reason this file exists. The framework read the body the only way
 * that works when it owns the socket, and a deployment where it does not own the socket is not an
 * exotic case — it is most of them. So the condition is reproduced here rather than discovered
 * again on a platform: the harness drains the request first, exactly as a body parser would, and
 * then calls the handler.
 */
const ROOT = fileURLToPath(new URL('../../../demo/', import.meta.url))

let handler: Handler | null = null
let server: Server | null = null

async function served(): Promise<string> {
  if (!server) {
    handler = await appHandler(await createApp(ROOT, { mode: 'dev' }))
    const h = handler
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // What a platform body parser does, and the only thing this harness adds.
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        ;(req as IncomingMessage & { body?: Buffer }).body = Buffer.concat(chunks)
        h.handle(req, res)
      })
    })
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  }
  const address = server.address()
  if (typeof address === 'string' || address === null) throw new Error('no address')
  return `http://127.0.0.1:${address.port}`
}

after(async () => {
  await handler?.close()
  if (server) {
    const s = server
    s.closeAllConnections()
    await new Promise<void>((resolve) => s.close(() => resolve()))
  }
})

/**
 * Five seconds is not a timing assertion. Every one of these answers in single-digit milliseconds
 * when the body is readable; the only thing this distinguishes is answered from never.
 */
async function answered(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(5_000) })
}

test('a POST answers when the host has already read the body', async () => {
  const base = await served()
  const response = await answered(`${base}/_weft/i/nothing.at.all`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'a=1',
  })
  // Which refusal it is belongs to the dispatch and is asserted elsewhere. What matters here is
  // that it refused rather than hung: an unknown intent has an answer, and 504 is not it.
  assert.ok(response.status >= 400 && response.status < 500, `expected a refusal, got ${response.status}`)
})

test('a POST with no body at all answers too', async () => {
  const base = await served()
  const response = await answered(`${base}/nope`, { method: 'POST' })
  assert.equal(response.status, 404)
})

test('the body still arrives: what the handler reads is what was sent', async () => {
  const base = await served()
  // `/_weft/token` reads its request and answers about it. Whatever it decides, it must decide —
  // and it cannot decide without the bytes.
  const response = await answered(`${base}/_weft/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ intent: 'nothing.at.all' }),
  })
  assert.notEqual(response.status, 504)
  assert.ok(response.status < 500, `the token endpoint failed rather than answered: ${response.status}`)
})

test('a GET is unaffected, because there was never a body to read', async () => {
  const base = await served()
  const response = await answered(`${base}/`, { method: 'GET' })
  assert.equal(response.status, 200)
})
