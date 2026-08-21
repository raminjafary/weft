import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assertValidTemplate,
  draftTemplate,
  seal,
  type EffectSet,
  type Hole,
  type TemplateIR,
} from '../../ir/src/index.ts'
import { createKernel, leaseCoalescer, type KernelRoute, type KernelSlot, type Ports } from '../src/index.ts'
import { collectingTelemetry } from '../../adapters/src/telemetry.ts'
import { cookieSession } from '../../adapters/src/session.ts'
import { memoryStore } from '../../adapters/src/memory-store.ts'
import { staticFlags } from '../../adapters/src/flags.ts'

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
        segments: ['<h1>', '</h1><section id="lines">', '</section><aside>', '</aside>'],
        holes: [
          hole(0, 'title', { path: [0] }),
          hole(1, 'lines', { kind: 'slot', path: [1] }),
          hole(2, 'greeting', { kind: 'slot', path: [2] }),
        ],
      }),
    ),
  )
}

function ports(
  store = memoryStore(),
  telemetry = collectingTelemetry(),
): Ports & { telemetry: typeof telemetry } {
  return {
    store,
    telemetry,
    session: cookieSession({ cookie: 'sid' }),
    flags: staticFlags({ axes: { 'new-cart': ['off', 'on'] } }),
    executors: {},
  }
}

function slot(name: string, reads: string[], extra: Partial<KernelSlot> = {}): KernelSlot {
  return {
    name,
    id: `fragment/${name}`,
    version: 'v1',
    effects: effects(reads),
    render: async () => utf8.encode(`<p>${name}</p>`),
    ...extra,
  }
}

async function route(slots: KernelSlot[], extra: Partial<KernelRoute> = {}): Promise<KernelRoute> {
  return { path: '/cart', template: await shell(), values: { title: 'Cart' }, slots, ...extra }
}

async function text(response: Response): Promise<string> {
  return response.text()
}

test('the shell goes out with headers derived from what the slots read', async () => {
  const kernel = createKernel({ ports: ports() })
  const response = await kernel.handle(
    new Request('https://example.test/cart', { headers: { cookie: 'currency=IQD; sid=u42' } }),
    await route([slot('lines', ['cookie:currency']), slot('greeting', ['identity'])]),
  )

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(response.headers.get('vary'), 'Cookie')
  // One private slot means the document may not be advertised as shared.
  assert.equal(response.headers.get('cache-control'), 'private, no-store')

  const body = await text(response)
  assert.match(body, /<h1>Cart<\/h1>/)
  assert.match(body, /<p>lines<\/p>/)
  assert.match(body, /<p>greeting<\/p>/)
  assert.deepEqual(kernel.trace?.states, ['received', 'envelope', 'planned', 'streaming', 'settled'])
})

test('a public policy on a route with a private slot is refused rather than emitted', async () => {
  const kernel = createKernel({ ports: ports() })
  const declared = await route([slot('lines', []), slot('greeting', ['identity'])], {
    policy: { class: 'public' },
  })
  await assert.rejects(
    () =>
      kernel.handle(new Request('https://example.test/cart', { headers: { cookie: 'sid=u42' } }), declared),
    /E_PRIVATE_AS_PUBLIC/,
  )
})

test('a slot with a policy is stored under its derived key and served from it next time', async () => {
  const store = memoryStore()
  const kernel = createKernel({ ports: ports(store) })
  let renders = 0
  const cached = (): KernelSlot =>
    slot('lines', ['cookie:currency'], {
      policy: { class: 'public', ttlMs: 60_000 },
      render: async () => {
        renders++
        return utf8.encode('<p>lines</p>')
      },
    })

  const first = await kernel.handle(
    new Request('https://example.test/cart', { headers: { cookie: 'currency=IQD' } }),
    await route([cached(), slot('greeting', [])]),
  )
  await text(first)
  assert.deepEqual(kernel.trace?.hits, [])

  const second = await kernel.handle(
    new Request('https://example.test/cart', { headers: { cookie: 'currency=IQD' } }),
    await route([cached(), slot('greeting', [])]),
  )
  await text(second)
  assert.deepEqual(kernel.trace?.hits, ['lines'])
  assert.equal(renders, 1)
})

test('a different cookie value is a different key, so it misses', async () => {
  const store = memoryStore()
  const kernel = createKernel({ ports: ports(store) })
  const cached = () => slot('lines', ['cookie:currency'], { policy: { class: 'public', ttlMs: 60_000 } })

  await text(
    await kernel.handle(
      new Request('https://example.test/cart', { headers: { cookie: 'currency=IQD' } }),
      await route([cached()]),
    ),
  )
  await text(
    await kernel.handle(
      new Request('https://example.test/cart', { headers: { cookie: 'currency=USD' } }),
      await route([cached()]),
    ),
  )
  assert.deepEqual(kernel.trace?.hits, [])
})

test('a slot that fails degrades to its placeholder and the rest of the page is untouched', async () => {
  const telemetry = collectingTelemetry()
  const kernel = createKernel({ ports: ports(memoryStore(), telemetry) })
  const response = await kernel.handle(
    new Request('https://example.test/cart'),
    await route([
      slot('lines', [], {
        onExceed: 'placeholder',
        placeholder: utf8.encode('<p class="skeleton"></p>'),
        render: async () => {
          throw new Error('upstream down')
        },
      }),
      slot('greeting', []),
    ]),
  )
  const body = await text(response)
  assert.match(body, /class="skeleton"/)
  assert.match(body, /<p>greeting<\/p>/)
  assert.equal(kernel.trace?.degraded[0]?.slot, 'lines')
  // A degradation nobody can see is a regression that looks like nothing at all.
  assert.equal(
    telemetry.measures.some((m) => m.name === 'slot.degraded'),
    true,
  )
})

test('a guard in phase A redirects with a real status and renders nothing', async () => {
  let rendered = 0
  const kernel = createKernel({ ports: ports() })
  const response = await kernel.handle(
    new Request('https://example.test/cart'),
    await route(
      [
        slot('lines', [], {
          render: async () => {
            rendered++
            return utf8.encode('x')
          },
        }),
      ],
      {
        envelope: (ctx) => {
          if (!ctx.cookie('sid')) ctx.redirect('/login')
        },
      },
    ),
  )
  assert.equal(response.status, 302)
  assert.equal(response.headers.get('location'), '/login')
  assert.equal(response.body, null)
  assert.equal(rendered, 0)
})

test('phase A can override a header the kernel would otherwise default', async () => {
  const kernel = createKernel({ ports: ports() })
  const response = await kernel.handle(
    new Request('https://example.test/cart'),
    await route([slot('lines', [])], {
      envelope: (ctx) => {
        ctx.setHeader('content-type', 'application/xhtml+xml')
      },
    }),
  )
  await text(response)
  assert.equal(response.headers.get('content-type'), 'application/xhtml+xml')
})

test('a cookie set in phase A is a real Set-Cookie on this response', async () => {
  const kernel = createKernel({ ports: ports() })
  const response = await kernel.handle(
    new Request('https://example.test/cart'),
    await route([slot('lines', [])], {
      envelope: (ctx) => {
        ctx.setCookie({ name: 'locale', value: 'ar', path: '/', httpOnly: true })
      },
    }),
  )
  await text(response)
  assert.match(response.headers.get('set-cookie') ?? '', /locale=ar; Path=\/; HttpOnly/)
})

test('a deferrable effect from a render lands on the next request on that connection', async () => {
  const kernel = createKernel({ ports: ports() })
  const deferring = (): KernelSlot =>
    slot('lines', [], {
      render: async () => utf8.encode('<p>lines</p>'),
    })

  const first = await kernel.handle(
    new Request('https://example.test/cart', { headers: { 'x-weft-connection': 'c1' } }),
    await route([
      {
        ...deferring(),
        render: async (ctx) => {
          ctx.defer({
            kind: 'cookie',
            cookie: { name: 'last-seen', value: '7', path: '/' },
            reason: 'timestamp',
          })
          return utf8.encode('<p>lines</p>')
        },
      },
    ]),
  )
  await text(first)
  assert.equal(first.headers.has('set-cookie'), false)

  const second = await kernel.handle(
    new Request('https://example.test/cart', { headers: { 'x-weft-connection': 'c1' } }),
    await route([deferring()]),
  )
  await text(second)
  assert.match(second.headers.get('set-cookie') ?? '', /last-seen=7/)
})

test('with no connection there is nowhere to defer to, and the effect is dropped', async () => {
  const kernel = createKernel({ ports: ports() })
  const response = await kernel.handle(
    new Request('https://example.test/cart'),
    await route([
      slot('lines', [], {
        render: async (ctx) => {
          ctx.defer({ kind: 'cookie', cookie: { name: 'last-seen', value: '7' }, reason: 'timestamp' })
          return utf8.encode('<p>lines</p>')
        },
      }),
    ]),
  )
  await text(response)
  assert.equal(kernel.mailbox.size, 0)
})

test('a render context has no envelope methods on it at all', async () => {
  const kernel = createKernel({ ports: ports() })
  const seen: string[] = []
  await text(
    await kernel.handle(
      new Request('https://example.test/cart'),
      await route([
        slot('lines', [], {
          render: async (ctx) => {
            seen.push(
              ...Object.keys(ctx).filter((k) => /cookie$|status|redirect|setHeader|setCookie/.test(k)),
            )
            assert.equal(ctx.phase, 'render')
            return utf8.encode('x')
          },
        }),
      ]),
    ),
  )
  assert.deepEqual(seen, ['cookie'])
})

test('slots render in waves, so a dependent slot sees its dependency finished', async () => {
  const order: string[] = []
  const kernel = createKernel({ ports: ports() })
  await text(
    await kernel.handle(
      new Request('https://example.test/cart'),
      await route([
        slot('lines', [], {
          render: async () => {
            await new Promise((r) => setTimeout(r, 10))
            order.push('lines')
            return utf8.encode('a')
          },
        }),
        slot('greeting', [], {
          needs: ['lines'],
          render: async () => {
            order.push('greeting')
            return utf8.encode('b')
          },
        }),
      ]),
    ),
  )
  assert.deepEqual(order, ['lines', 'greeting'])
})

test('two concurrent requests for one cacheable slot render it once', async () => {
  const store = memoryStore()
  let renders = 0
  const cached = (): KernelSlot =>
    slot('lines', ['cookie:currency'], {
      policy: { class: 'public', ttlMs: 60_000 },
      render: async () => {
        renders++
        await new Promise((resolve) => setTimeout(resolve, 25))
        return utf8.encode('<p>lines</p>')
      },
    })
  const kernel = createKernel({
    ports: ports(store),
    coalesce: leaseCoalescer(store, { pollMs: 2 }),
  })
  const request = async (): Promise<string> =>
    text(
      await kernel.handle(
        new Request('https://example.test/cart', { headers: { cookie: 'currency=IQD' } }),
        await route([cached()]),
      ),
    )

  const [a, b] = await Promise.all([request(), request()])
  assert.equal(renders, 1, 'the second request waited for the first rather than rendering again')
  assert.equal(a, b, 'and both got the same bytes')
  assert.deepEqual(kernel.trace?.coalesced, ['lines'], 'the trace says a stampede was avoided')
})

test('an out-of-order response carries the fill mechanism it depends on', async () => {
  // Found by opening the demo in a browser: `fillFor` emits `__w(...)`, `streamRoute` only sent
  // the filler when a caller passed one, and `kernel.handle` did not. Every out-of-order response
  // the kernel produced threw `__w is not defined` — and no test caught it, because every test
  // read the body as bytes and never as a page.
  const kernel = createKernel({ ports: ports() })
  const body = await text(
    await kernel.handle(
      new Request('https://example.test/cart'),
      await route([slot('lines', []), slot('greeting', [])], { order: 'out-of-order' }),
    ),
  )
  const filler = body.indexOf('window.__w=')
  const firstFill = body.indexOf('__w(')
  assert.ok(filler >= 0, 'the filler script is in the response')
  assert.ok(firstFill > filler, 'and it arrives before the first call to it')
  assert.equal(body.includes('<!--w:lines-->'), true, 'each slot left an anchor for the fill to find')
})

test('an in-order response does not carry the filler, because it needs no fill mechanism', async () => {
  const kernel = createKernel({ ports: ports() })
  const body = await text(
    await kernel.handle(
      new Request('https://example.test/cart'),
      await route([slot('lines', []), slot('greeting', [])], { order: 'in-order' }),
    ),
  )
  assert.equal(body.includes('window.__w='), false, 'nothing to fill, so nothing is paid for')
  assert.equal(body.includes('<!--w:'), false)
})
