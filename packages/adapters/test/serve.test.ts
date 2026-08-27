import assert from 'node:assert/strict'
import { test } from 'node:test'
import { connect } from 'node:net'
import {
  assertValidTemplate,
  draftTemplate,
  seal,
  type EffectSet,
  type Hole,
  type TemplateIR,
} from '@weftjs/ir'
import { createKernel, type KernelRoute, type Ports } from '@weftjs/kernel'
import { memoryStore } from '../src/memory-store.ts'
import { cookieSession } from '../src/session.ts'
import { staticFlags } from '../src/flags.ts'
import { mountKernel, nodeTransport } from '../src/node-transport.ts'

const utf8 = new TextEncoder()

function effects(reads: string[]): EffectSet {
  return { reads: [...reads].sort(), writes: [], envelope: [], residency: reads.length ? 'server' : 'either' }
}

function hole(index: number, binding: string, extra: Partial<Hole> = {}): Hole {
  return { index, kind: 'text', escape: 'escape', binding, path: [index], ...extra }
}

async function shell(): Promise<TemplateIR> {
  return assertValidTemplate(
    await seal(
      draftTemplate({
        id: 'route/cart',
        segments: ['<h1>', '</h1><section>', '</section>'],
        holes: [hole(0, 'title', { path: [0] }), hole(1, 'lines', { kind: 'slot', path: [1] })],
      }),
    ),
  )
}

function ports(): Ports {
  return {
    store: memoryStore(),
    session: cookieSession({ cookie: 'sid' }),
    flags: staticFlags({ axes: { 'new-cart': ['off', 'on'] } }),
    executors: {},
  }
}

async function route(): Promise<KernelRoute> {
  return {
    path: '/cart',
    template: await shell(),
    values: { title: 'Cart' },
    critical: [
      { href: '/cart.css', as: 'style', rel: 'preload' },
      { href: '/cart.js', as: 'script', rel: 'modulepreload' },
    ],
    slots: [
      {
        name: 'lines',
        id: 'fragment/lines',
        version: 'v1',
        effects: effects(['cookie:currency']),
        render: async (ctx) => utf8.encode(`<p>${ctx.cookie('currency') ?? 'IQD'}</p>`),
      },
    ],
  }
}

/** Raw HTTP, because an informational response is invisible to fetch(). */
function rawGet(url: string, headers: Record<string, string> = {}): Promise<string> {
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const socket = connect({ host: target.hostname, port: Number(target.port) }, () => {
      const lines = [
        `GET ${target.pathname} HTTP/1.1`,
        `Host: ${target.host}`,
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        'Connection: close',
        '',
        '',
      ]
      socket.write(lines.join('\r\n'))
    })
    let raw = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      raw += chunk
    })
    socket.on('end', () => resolve(raw))
    socket.on('error', reject)
  })
}

test('a 103 precedes the 200, and the envelope was still open when it went out', async () => {
  const prepared = await route()
  const mounted = await mountKernel({
    path: '/cart',
    kernel: (transport) => createKernel({ ports: { ...ports(), transport } }),
    route: () => prepared,
  })
  try {
    const raw = await rawGet(mounted.url, { cookie: 'currency=IQD' })
    const informational = raw.indexOf('HTTP/1.1 103')
    const final = raw.indexOf('HTTP/1.1 200')
    assert.ok(informational >= 0, 'no 103 in the response')
    assert.ok(final > informational, '103 did not precede the final response')
    assert.match(raw, /Link: <\/cart\.css>; rel=preload; as=style, <\/cart\.js>; rel=modulepreload/i)
    assert.match(raw, /<h1>Cart<\/h1>/)
    assert.match(raw, /<p>IQD<\/p>/)
    // Derived from the slot's read, and written before the seal.
    assert.match(raw, /vary: Cookie/i)
  } finally {
    await mounted.close()
  }
})

test('the kernel is a Request in and a Response out, so mounting it is this small', async () => {
  const prepared = await route()
  const mounted = await mountKernel({
    path: '/cart',
    kernel: (transport) => createKernel({ ports: { ...ports(), transport } }),
    route: () => prepared,
  })
  try {
    const response = await fetch(mounted.url, { headers: { cookie: 'currency=USD' } })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /<p>USD<\/p>/)
    const missing = await fetch(new URL('/nope', mounted.url))
    assert.equal(missing.status, 404)
  } finally {
    await mounted.close()
  }
})

test('a transport with no 103 support reports false rather than claiming a send', () => {
  const transport = nodeTransport({} as never)
  assert.equal(transport.earlyHints?.([{ href: '/a.css', as: 'style', rel: 'preload' }]), false)
  assert.equal(transport.earlyHints?.([]), false)
})
