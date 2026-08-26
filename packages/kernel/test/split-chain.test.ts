import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertValidTemplate, draftTemplate, seal, type Hole, type TemplateIR } from '@weft/ir'
import { chainSplitter, splitAtSlots, streamRoute, type Route } from '../src/index.ts'

const decoder = new TextDecoder()

function hole(index: number, binding: string, extra: Partial<Hole> = {}): Hole {
  return { index, kind: 'text', escape: 'escape', binding, path: [index], ...extra }
}

/** `<h1>{title}</h1><header>SLOT top</header><main>SLOT body</main><footer>SLOT foot</footer>` */
async function outer(): Promise<TemplateIR> {
  return assertValidTemplate(
    await seal(
      draftTemplate({
        id: 'outer',
        segments: ['<h1>', '</h1><header>', '</header><main>', '</main><footer>', '</footer>'],
        holes: [
          hole(0, 'title', { path: [0] }),
          hole(1, 'top', { kind: 'slot', path: [1] }),
          hole(2, 'body', { kind: 'slot', path: [2] }),
          hole(3, 'foot', { kind: 'slot', path: [3] }),
        ],
      }),
    ),
  )
}

/** `<div class="{skin}"><aside>SLOT toc</aside><article>SLOT body</article></div>` */
async function inner(): Promise<TemplateIR> {
  return assertValidTemplate(
    await seal(
      draftTemplate({
        id: 'inner',
        segments: ['<div class="', '"><aside>', '</aside><article>', '</article></div>'],
        holes: [
          hole(0, 'skin', { kind: 'attr', attr: 'class', path: [0] }),
          hole(1, 'toc', { kind: 'slot', path: [1] }),
          hole(2, 'body', { kind: 'slot', path: [2] }),
        ],
      }),
    ),
  )
}

const VALUES = { title: 'Title', skin: 'docs', top: '', body: '', foot: '', toc: '' }

function route(
  template: TemplateIR,
  links: { at: string; template: TemplateIR }[],
  delays: Record<string, number>,
): Route {
  return {
    template,
    values: VALUES,
    ...(links.length ? { split: chainSplitter(links) } : {}),
    slots: Object.fromEntries(
      Object.entries(delays).map(([slot, ms]) => [
        slot,
        () => new Promise<string>((resolve) => setTimeout(() => resolve(`<p>${slot}</p>`), ms)),
      ]),
    ),
  }
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) text += decoder.decode(value)
  }
  return text
}

test('a chain leaves the union of its layers holes, minus the one the link fills', async () => {
  const split = chainSplitter([{ at: 'body', template: await inner() }])(await outer(), VALUES)
  assert.deepEqual(split.slots, ['top', 'toc', 'body', 'foot'])
  assert.equal(split.chunks.length, split.slots.length + 1, 'one more chunk than slots, as for any document')
})

test('the nested layout is spliced where the enclosing one left a hole, not appended', async () => {
  const split = chainSplitter([{ at: 'body', template: await inner() }])(await outer(), VALUES)
  const text = split.chunks.map((chunk) => decoder.decode(chunk)).join('|')
  assert.equal(
    text,
    '<h1>Title</h1><header>|</header><main><div class="docs"><aside>|</aside><article>|</article></div></main><footer>|</footer>',
  )
})

test('a chain of three is spliced all the way down', async () => {
  const deepest = assertValidTemplate(
    await seal(
      draftTemplate({
        id: 'deepest',
        segments: ['<section>', '</section>'],
        holes: [hole(0, 'body', { kind: 'slot', path: [0] })],
      }),
    ),
  )
  const split = chainSplitter([
    { at: 'body', template: await inner() },
    { at: 'body', template: deepest },
  ])(await outer(), VALUES)
  assert.deepEqual(split.slots, ['top', 'toc', 'body', 'foot'])
  const text = split.chunks.map((chunk) => decoder.decode(chunk)).join('')
  assert.ok(text.includes('<article><section>'), text)
})

test('a link with nowhere to go is left unspliced rather than throwing', async () => {
  const split = chainSplitter([{ at: 'nowhere', template: await inner() }])(await outer(), VALUES)
  assert.deepEqual(split.slots, ['top', 'body', 'foot'], 'the flat cut, unchanged')
})

test('with no links, the chain splitter is the flat splitter', async () => {
  const ir = await outer()
  const flat = splitAtSlots(ir, VALUES)
  const chained = chainSplitter([])(ir, VALUES)
  assert.deepEqual(chained.slots, flat.slots)
  assert.deepEqual(
    chained.chunks.map((c) => decoder.decode(c)),
    flat.chunks.map((c) => decoder.decode(c)),
  )
})

test('in-order, a nested layout region streams where the layout is', async () => {
  const text = await collect(
    streamRoute(
      route(await outer(), [{ at: 'body', template: await inner() }], { top: 0, toc: 0, body: 0, foot: 0 }),
      {
        order: 'in-order',
      },
    ),
  )
  assert.equal(
    text,
    '<h1>Title</h1><header><p>top</p></header><main><div class="docs"><aside><p>toc</p></aside>' +
      '<article><p>body</p></article></div></main><footer><p>foot</p></footer>',
  )
})

test('out-of-order, the shell carries an anchor for every hole in the chain', async () => {
  const text = await collect(
    streamRoute(
      route(await outer(), [{ at: 'body', template: await inner() }], { top: 30, toc: 0, body: 10, foot: 0 }),
      { order: 'out-of-order' },
    ),
  )
  for (const slot of ['top', 'toc', 'body', 'foot']) {
    assert.ok(text.includes(`<!--w:${slot}-->`), `no anchor for ${slot}`)
  }
  // Fastest first, across the layers: the nested layout's fast region is not held behind the
  // outer layout's slow one, which is the whole claim and would be false if the chain were
  // streamed layer by layer.
  assert.ok(
    text.indexOf('data-w="toc"') < text.indexOf('data-w="top"'),
    'the nested toc resolved first and was sent first',
  )
})
