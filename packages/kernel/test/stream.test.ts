import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assertValidTemplate,
  draftTemplate,
  render,
  seal,
  type Hole,
  type TemplateIR,
} from '../../ir/src/index.ts'
import { fillFor, splitAtSlots, streamRoute, type Route } from '../src/index.ts'

const decoder = new TextDecoder()

function hole(index: number, binding: string, extra: Partial<Hole> = {}): Hole {
  return { index, kind: 'text', escape: 'escape', binding, path: [index], ...extra }
}

/** `<h1>{title}</h1><section>SLOT a</section><section>SLOT b</section>` */
async function shell(): Promise<TemplateIR> {
  return assertValidTemplate(
    await seal(
      draftTemplate({
        id: 'shell',
        segments: ['<h1>', '</h1><section id="a">', '</section><section id="b">', '</section>'],
        holes: [
          hole(0, 'title', { path: [0] }),
          hole(1, 'a', { kind: 'slot', path: [1] }),
          hole(2, 'b', { kind: 'slot', path: [2] }),
        ],
      }),
    ),
  )
}

function route(ir: TemplateIR, delays: Record<string, number>): Route {
  return {
    template: ir,
    values: { title: 'Title', a: '', b: '' },
    slots: Object.fromEntries(
      Object.entries(delays).map(([slot, ms]) => [
        slot,
        () => new Promise<string>((resolve) => setTimeout(() => resolve(`<p>${slot}</p>`), ms)),
      ]),
    ),
  }
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<{ text: string; chunks: string[] }> {
  const reader = stream.getReader()
  const chunks: string[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(decoder.decode(value))
  }
  return { text: chunks.join(''), chunks }
}

test('the shell is cut at its slots, one more chunk than slots', async () => {
  const split = splitAtSlots(await shell(), { title: 'Title', a: '', b: '' })
  assert.deepEqual(split.slots, ['a', 'b'])
  assert.equal(split.chunks.length, split.slots.length + 1)
  assert.equal(decoder.decode(split.chunks[0] as Uint8Array), '<h1>Title</h1><section id="a">')
})

test('a slot contributes no bytes of its own to the shell', async () => {
  const ir = await shell()
  const split = splitAtSlots(ir, { title: 'T', a: 'ignored', b: 'ignored' })
  assert.equal(
    split.chunks
      .map((c) => decoder.decode(c))
      .join('')
      .includes('ignored'),
    false,
  )
})

test('in-order streaming puts each region where the document says', async () => {
  const ir = await shell()
  const { text } = await collect(streamRoute(route(ir, { a: 5, b: 1 }), { order: 'in-order' }))
  assert.equal(text, '<h1>Title</h1><section id="a"><p>a</p></section><section id="b"><p>b</p></section>')
})

test('in-order streaming holds a fast region behind a slow one', async () => {
  const ir = await shell()
  const stream = streamRoute(route(ir, { a: 40, b: 0 }), { order: 'in-order' })
  const reader = stream.getReader()
  const start = Date.now()
  await reader.read() // the shell up to the first slot
  const shellAt = Date.now() - start
  await reader.read() // region a, which the whole document waits for
  const firstRegionAt = Date.now() - start
  await reader.cancel()
  assert.ok(shellAt < 20, `the shell should not wait: ${shellAt}ms`)
  assert.ok(firstRegionAt >= 35, `the first region is the slow one: ${firstRegionAt}ms`)
})

test('out-of-order streaming sends the whole shell before any region', async () => {
  const ir = await shell()
  const { chunks } = await collect(
    streamRoute(route(ir, { a: 30, b: 1 }), { order: 'out-of-order', filler: '<script>/*f*/</script>' }),
  )
  const beforeFirstFill = chunks
    .slice(
      0,
      chunks.findIndex((c) => c.includes('data-w=')),
    )
    .join('')
  assert.equal(beforeFirstFill.includes('<section id="a">'), true)
  assert.equal(beforeFirstFill.includes('<section id="b">'), true)
  assert.equal(beforeFirstFill.includes('<!--w:a-->'), true)
  assert.equal(beforeFirstFill.includes('<!--w:b-->'), true)
})

test('out-of-order streaming fills whichever region resolves first', async () => {
  const ir = await shell()
  const { text } = await collect(streamRoute(route(ir, { a: 40, b: 1 }), { order: 'out-of-order' }))
  assert.ok(
    text.indexOf('data-w="b"') < text.indexOf('data-w="a"'),
    'b resolves first and should arrive first',
  )
})

test('an anchor is left in place, so the region can be filled again later', async () => {
  const ir = await shell()
  const { text } = await collect(streamRoute(route(ir, { a: 1, b: 1 }), { order: 'out-of-order' }))
  assert.equal(text.includes('<!--w:a-->'), true)
})

test('region content is not escaped for JavaScript on the way', () => {
  const content = new TextEncoder().encode('<p title="a &amp; b">it\'s </script> fine</p>')
  const filled = decoder.decode(fillFor('a', content))
  assert.equal(filled.includes('<p title="a &amp; b">'), true, 'markup travels as markup')
  assert.equal(filled.includes('\\u003c'), false, 'nothing is JavaScript-escaped')
  assert.equal(filled.startsWith('<template data-w="a">'), true)
})

test('a route with no slots streams as one document and needs no filler', async () => {
  const ir = assertValidTemplate(
    await seal(
      draftTemplate({ id: 'flat', segments: ['<p>', '</p>'], holes: [hole(0, 'title', { path: [0] })] }),
    ),
  )
  const { text } = await collect(
    streamRoute(
      { template: ir, values: { title: 'x' }, slots: {} },
      { order: 'out-of-order', filler: '<script>F</script>' },
    ),
  )
  assert.equal(text, '<p>x</p>')
})

test('an isolated instance is cut out of the shell exactly as a slot is', async () => {
  const child = await seal(
    draftTemplate({
      id: 'who',
      segments: ['<b>', '</b>'],
      holes: [{ index: 0, kind: 'text', escape: 'escape', binding: 'name', path: [0] }],
    }),
  )
  const shellIr = await seal(
    draftTemplate({
      id: 'shell',
      segments: ['<p>', '', '</p>'],
      holes: [
        { index: 0, kind: 'text', escape: 'escape', binding: 'currency', path: [0] },
        {
          index: 1,
          kind: 'component',
          escape: 'trusted-raw',
          binding: 'c0',
          path: [0, 0],
          nested: child.version,
          props: { name: 'who' },
          provenance: 'who',
          isolated: true,
        },
      ],
    }),
  )
  const resolve = (v: string) => (v === child.version ? child : undefined)

  // The shell renders without the private child in it, which is the whole point: those
  // bytes are cacheable for everyone.
  assert.equal(decoder.decode(render(shellIr, { currency: 'IQD', who: 'Sara' }, resolve)), '<p>IQD</p>')

  const split = splitAtSlots(shellIr, { currency: 'IQD' }, resolve)
  assert.deepEqual(split.slots, ['c0'], 'the instance is a cut, not a value')
  assert.equal(split.chunks.length, 2)

  const streamed = await collect(
    streamRoute(
      {
        template: shellIr,
        values: { currency: 'IQD' },
        resolve,
        slots: { c0: async () => render(child, { name: 'Sara' }) },
      },
      { order: 'in-order' },
    ),
  )
  assert.equal(streamed.text, '<p>IQD<b>Sara</b></p>', 'composed at stream time, from two cache entries')
})
