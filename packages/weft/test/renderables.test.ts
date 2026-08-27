import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { TEMPLATE_IR_VERSION } from '@weftjs/ir'
import { frame, residentFrame, str, WARP_VERSION, type Frame } from '@weftjs/warp'
import { countingLimits, memoryStore } from '@weftjs/adapters'
import type { ChannelSink } from '@weftjs/kernel'
import { createApp, serveApp, type Serving } from '../src/serve.ts'

/**
 * Render intents: the catalogue half of phase 7, which was waiting for the registry.
 *
 * The authority half is the intent dispatch's and is tested with it — the same capability check, the
 * same verifier, the same limiter, bound from the same place. What is tested here is what the
 * catalogue adds: an id that discloses nothing, an entry that has to be *in* the catalogue to be
 * reachable, params validated before they reach a template, a slot checked against the page it is
 * going into, and the surgical ladder surviving all of it.
 */
const ROOT = fileURLToPath(new URL('../../../demo/', import.meta.url))
const utf8 = new TextEncoder()

const servers: Serving[] = []
after(async () => {
  for (const serving of servers) await serving.close()
})

async function app(overrides: Parameters<typeof createApp>[1] = {}): Promise<Serving> {
  const serving = await serveApp(await createApp(ROOT, { mode: 'dev', port: 0, ...overrides }))
  servers.push(serving)
  return serving
}

function sink(): ChannelSink & { frames: Frame[] } {
  const frames: Frame[] = []
  return {
    frames,
    binding: 'socket',
    open: true,
    send(batch) {
      frames.push(...batch)
    },
    close() {},
  }
}

async function channel(serving: Serving, at: string): Promise<string> {
  const id = `c-${Math.random().toString(36).slice(2, 8)}`
  serving.app.at.set(id, { path: at, cookie: '' })
  serving.app.hub.open(sink(), id)
  await serving.app.hub.receive(id, [
    residentFrame({ warp: WARP_VERSION, ir: TEMPLATE_IR_VERSION, forms: ['html', 'delta', 'patch'] }),
  ])
  return id
}

async function ask(
  serving: Serving,
  connection: string,
  named: string,
  slot: string,
  params: unknown = {},
): Promise<Frame[]> {
  return serving.app.hub.receive(connection, [
    frame('REFRESH', { s: slot, r: named }, utf8.encode(JSON.stringify(params))),
  ])
}

function errorOf(frames: readonly Frame[]): { code: string | undefined; detail: string | undefined } {
  const found = frames.find((f) => f.kind === 'ERROR')
  return { code: found && str(found, 'code'), detail: found && str(found, 'detail') }
}

/**
 * What came back, in one line, for an assertion that has to say what went wrong.
 *
 * A refusal here is a named code with a reason attached, and an assertion that only said
 * `undefined !== 'E_SOMETHING'` would throw that away — which is the difference between a failure
 * somebody can act on and one they have to reproduce first.
 */
function said(frames: readonly Frame[]): string {
  return frames.map((f) => `${f.kind}${str(f, 'code') ? `:${str(f, 'code')}` : ''}`).join(' ')
}

test('the catalogue is a directory, and its ids are derived rather than declared', async () => {
  const serving = await app()
  const entries = serving.app.catalogue.entries

  assert.deepEqual(
    entries.map((e) => e.name).sort(),
    ['card.product', 'card.search'],
    'app/renderables/, and nothing else in the application, is what a client may name',
  )
  for (const entry of entries) {
    assert.match(entry.id, /^[0-9a-f]{6}$/, 'six hex characters, from the module and the export')
    assert.equal(
      entry.id.includes(entry.name) || entry.id.includes('card'),
      false,
      'and it discloses nothing about what runs',
    )
  }
  // The point of the port. One entry is rendered here and one somewhere else, and the id says neither.
  assert.deepEqual(entries.map((e) => e.by).sort(), ['fragment:product-card', 'region:search'])
})

test('a fragment nobody put in the catalogue is not renderable, however compiled it is', async () => {
  // Otherwise every component in an application would be a public endpoint taking arbitrary props.
  const serving = await app()
  const id = await channel(serving, '/app/feed')
  assert.equal(errorOf(await ask(serving, id, 'product-card', 'body')).code, 'E_NO_SUCH_RENDERABLE')
  assert.equal(errorOf(await ask(serving, id, 'feed', 'body')).code, 'E_NO_SUCH_RENDERABLE')
})

test('an entry in the catalogue renders into the slot, by the name its author gave it', async () => {
  const serving = await app()
  const id = await channel(serving, '/app/feed')
  const out = await ask(serving, id, 'card.product', 'body', { sku: 'OIL-2L' })

  const painted = out.find((f) => str(f, 's') === 'body') as Frame
  assert.ok(painted, `the answer addresses the slot that was asked for: ${said(out)}`)
  assert.equal(errorOf(out).code, undefined, said(out))
})

test('the opaque id works too, and it is what a build would put in markup', async () => {
  const serving = await app()
  const id = await channel(serving, '/app/feed')
  const opaque = serving.app.catalogue.names['card.product'] as string
  const out = await ask(serving, id, opaque, 'body', { sku: 'OIL-2L' })

  assert.equal(errorOf(out).code, undefined, `${said(out)} — ${errorOf(out).detail ?? ''}`)
  assert.ok(
    out.some((f) => str(f, 's') === 'body'),
    said(out),
  )
})

test('params are validated before they reach a template, because they came from a browser', async () => {
  // Stronger than an intent's input gate: an intent's payload reaches code somebody wrote to expect
  // it, and this one reaches a template — so an unvalidated value is an unvalidated hole.
  const serving = await app()
  const id = await channel(serving, '/app/feed')
  const refused = errorOf(await ask(serving, id, 'card.product', 'body', { sku: 'NOT-A-SKU' }))

  assert.equal(refused.code, 'E_RENDER_INPUT')
  assert.match(refused.detail ?? '', /NOT-A-SKU is not a product/)
})

test('a slot that is not a hole on this page is refused, and the refusal names the holes', async () => {
  // Route knowledge, so it is checked where the route is known rather than in the dispatch.
  const serving = await app()
  const id = await channel(serving, '/app/feed')
  const refused = errorOf(await ask(serving, id, 'card.product', 'nowhere', { sku: 'OIL-2L' }))

  assert.equal(refused.code, 'E_NO_SUCH_SLOT')
  assert.match(refused.detail ?? '', /panel, body, readout/)
})

test('an entry served by a region goes through the composer, so which deployment renders it is a registry write', async () => {
  const serving = await app()
  const id = await channel(serving, '/app/composed')
  const out = await ask(serving, id, 'card.search', 'search', { q: 'tea' })

  const painted = out.find((f) => str(f, 's') === 'search') as Frame
  assert.ok(painted, 'the region answered into the slot')
  assert.match(
    new TextDecoder().decode(painted.body as Uint8Array),
    /rendered by the search deployment/,
    'and the bytes came from the far side of a real boundary',
  )
  assert.equal(errorOf(out).code, undefined, said(out))
})

test('a deployment whose registry answers no renderable refuses the question rather than answering it with silence', async () => {
  const serving = await app()
  const id = await channel(serving, '/app/feed')
  // An id that is well-formed and in nobody's catalogue. Deny by default, and say nothing about what
  // else is in there: an id is opaque precisely so that guessing at one learns nothing.
  const refused = errorOf(await ask(serving, id, 'aaaaaa', 'body'))
  assert.equal(refused.code, 'E_NO_SUCH_RENDERABLE')
  assert.equal(refused.detail?.includes('card.product'), false, 'and it does not list the catalogue')
})

test('an entry that declares a limit is limited, by whatever this deployment counts against', async () => {
  // A frozen clock, because the window is fixed rather than sliding: sixty calls that straddle a
  // boundary land in two buckets and neither reaches the ceiling. That is the adapter's stated cost
  // and not what this test is about.
  const serving = await app({
    limits: countingLimits({
      store: memoryStore(),
      counted: (): string => 'one-caller',
      now: () => 1_700_000_000_000,
    }),
  })
  const id = await channel(serving, '/app/feed')
  // card.product declares 60 per 10s.
  const codes: (string | undefined)[] = []
  for (let i = 0; i < 61; i++) {
    codes.push(errorOf(await ask(serving, id, 'card.product', 'body', { sku: 'OIL-2L' })).code)
  }

  assert.equal(codes.filter((code) => code === 'E_RATE_LIMITED').length, 1)
  assert.equal(codes.at(-1), 'E_RATE_LIMITED', 'the sixty-first, and not an arbitrary one')
})

test('an entry that declares a limit no port can count is refused rather than unlimited', async () => {
  const serving = await app({ limits: undefined } as unknown as Parameters<typeof createApp>[1])
  const id = await channel(serving, '/app/feed')
  assert.equal(
    errorOf(await ask(serving, id, 'card.product', 'body', { sku: 'OIL-2L' })).code,
    'E_NO_RATE_LIMIT',
  )
})
