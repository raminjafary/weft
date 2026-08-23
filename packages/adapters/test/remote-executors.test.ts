import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, test } from 'node:test'
import { bindingExecutor, isolateExecutor, renderService, svcExecutor } from '../src/index.ts'
import type { RenderJob } from '@weft/kernel'

// A URL rather than a path: an address's module specifier is resolved against it, and the other
// side of every one of these crash domains resolves with `new URL`.
const FIXTURES = new URL('../fixtures/', import.meta.url).href
const decoder = new TextDecoder()

/**
 * The three executor kinds the design named and nothing implemented.
 *
 * Each one is a separate crash domain and each one is tested against a real one: a real worker
 * thread, a real `fetch` handler, a real HTTP server on a real port. A mock executor would prove
 * that the interface is satisfiable, which was never the question.
 */
function job(slot: string, address: RenderJob['address'], cpuBudgetMs?: number): RenderJob {
  return {
    slot,
    ...(address ? { address } : {}),
    ...(cpuBudgetMs !== undefined ? { cpuBudgetMs } : {}),
    run: () => Promise.reject(new Error('a closure does not cross a crash domain')),
  }
}

const servers: { close(): Promise<void> }[] = []
after(async () => {
  for (const server of servers) await server.close()
})

test('an isolate renders by name, because a closure cannot cross into one', async () => {
  const executor = isolateExecutor({ root: FIXTURES })
  const outcome = await executor.run(
    job('card', { module: './renderers.ts', export: 'greeting', props: { name: 'Amber rice' } }),
  )
  assert.equal(outcome.failure, undefined)
  assert.match(decoder.decode(outcome.bytes), /Amber rice/)
  assert.equal(executor.kind, 'isolate')
  assert.equal(executor.preemption, 'always', 'its own stack, so a budget on it is a limit')
})

test('an isolate without an address refuses by name rather than running on the request thread', async () => {
  const executor = isolateExecutor({ root: FIXTURES })
  await assert.rejects(() => executor.run(job('card', undefined)), /E_JOB_NOT_ADDRESSABLE/)
})

test('a synchronous render past its budget is killed on an isolate, not reported after the fact', async () => {
  const executor = isolateExecutor({ root: FIXTURES })
  const outcome = await executor.run(job('spin', { module: './renderers.ts', export: 'spin' }, 120))
  assert.equal(outcome.failure?.code, 'E_CPU_BUDGET')
  assert.match(outcome.failure?.message ?? '', /killed/)
  // The point of the whole kind: a tight loop with no await in it went straight through the
  // inline executor's budget and is stopped here.
  assert.ok(outcome.ms < 2_000, `killed near its budget rather than at completion (${outcome.ms}ms)`)
})

test('a binding is a call, so the deadline is on waiting and the executor says so', async () => {
  const service = renderService({ root: FIXTURES })
  const executor = bindingExecutor({ binding: service })
  const outcome = await executor.run(
    job('card', { module: './renderers.ts', export: 'greeting', props: { name: 'Barhi dates' } }),
  )
  assert.equal(outcome.failure, undefined)
  assert.match(decoder.decode(outcome.bytes), /Barhi dates/)
  assert.equal(executor.kind, 'binding')
  assert.equal(
    executor.preemption,
    'at-await',
    'a binding can be abandoned and not killed, so a budget on it bounds latency and not work',
  )
})

test('a binding that answers badly degrades the slot and names the status', async () => {
  const executor = bindingExecutor({ binding: () => new Response('no', { status: 503 }) })
  const outcome = await executor.run(job('card', { module: './renderers.ts', export: 'greeting' }))
  assert.equal(outcome.failure?.code, 'E_SLOT_FAILED')
  assert.match(outcome.failure?.message ?? '', /503/)
})

test('a binding that never answers is given up on, and the message admits what that means', async () => {
  const executor = bindingExecutor({
    binding: (request) =>
      new Promise<Response>((_, reject) => {
        request.signal.addEventListener('abort', () => reject(new Error('aborted')))
      }),
    timeoutMs: 40,
  })
  const outcome = await executor.run(job('card', { module: './renderers.ts', export: 'greeting' }))
  assert.equal(outcome.failure?.code, 'E_CPU_BUDGET')
  assert.match(outcome.failure?.message ?? '', /may still be running/)
})

test('a service on another port renders the same job over the network', async () => {
  const handler = renderService({ root: FIXTURES })
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const response = await handler(
        new Request(`http://localhost${req.url ?? '/'}`, { method: 'POST', body: Buffer.concat(chunks) }),
      )
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'text/plain' })
      res.end(Buffer.from(await response.arrayBuffer()))
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address === 'string' || !address) throw new Error('no address')
  servers.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })

  const executor = svcExecutor({ url: `http://127.0.0.1:${address.port}/render` })
  const outcome = await executor.run(
    job('card', { module: './renderers.ts', export: 'greeting', props: { name: 'Ceylon tea' } }),
  )
  assert.equal(outcome.failure, undefined)
  assert.match(decoder.decode(outcome.bytes), /Ceylon tea/)
  assert.equal(executor.kind, 'svc')
})

test('a service that is not there degrades the slot rather than failing the page', async () => {
  // Port zero never listens, so this is a connection refused rather than a slow answer.
  const executor = svcExecutor({ url: 'http://127.0.0.1:1/render', timeoutMs: 200 })
  const outcome = await executor.run(job('card', { module: './renderers.ts', export: 'greeting' }))
  assert.equal(outcome.failure?.code, 'E_SLOT_FAILED')
  assert.equal(outcome.bytes.length, 0, 'no bytes, so the slot degrades to its placeholder')
})

test('a service asked for an export that does not exist says which one', async () => {
  const executor = bindingExecutor({ binding: renderService({ root: FIXTURES }) })
  const outcome = await executor.run(job('card', { module: './renderers.ts', export: 'nope' }))
  assert.equal(outcome.failure?.code, 'E_SLOT_FAILED')
  assert.match(outcome.failure?.message ?? '', /422/)
})
