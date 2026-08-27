import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chainFor, createApp, discover, type DiscoveredNested } from '@weftjs/core/server'

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))

/**
 * A whole application, written to disk for one assertion and removed again.
 *
 * The refusals below are build errors, and a build error aborts the application — so each case
 * needs an application of its own. Written here rather than committed because what is being tested
 * is a *shape* of file tree: four files, of which one is the point, and a committed fixture per
 * refusal would be four directories nobody reads.
 */
async function fixture(name: string, files: Record<string, string>): Promise<string> {
  const root = join(FIXTURES, `chain-${name}`)
  await rm(root, { recursive: true, force: true })
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  return root
}

const OUTER = (holes: string) => `import { fragment, raw } from '@weftjs/core'

interface Props {
  title: string
  css: string
  runtime: string
${holes
  .split(' ')
  .map((hole) => `  ${hole}: string`)
  .join('\n')}
}

export default fragment(({ title, css, runtime, ${holes.split(' ').join(', ')} }: Props) => (
  <>
    {raw('<!doctype html>')}
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>{title}</title>
        <link rel="stylesheet" href={css} />
        <script type="module" src={runtime} />
      </head>
      <body>
${holes
  .split(' ')
  .map((hole) => `        <section><slot name="${hole}">{${hole}}</slot></section>`)
  .join('\n')}
      </body>
    </html>
  </>
))
`

const INNER = (holes: string) => `import { fragment } from '@weftjs/core'

interface Props {
${holes
  .split(' ')
  .map((hole) => `  ${hole}: string`)
  .join('\n')}
}

export default fragment(({ ${holes.split(' ').join(', ')} }: Props) => (
  <div class="wrap">
${holes
  .split(' ')
  .map((hole) => `    <div><slot name="${hole}">{${hole}}</slot></div>`)
  .join('\n')}
  </div>
))
`

const PAGE = (slots: string[]) => `import { defineRoute } from '@weftjs/core'

export default defineRoute({
  head: { title: 'fixture' },
  slots: {
${slots.map((name) => `    ${name}: { stream: false, html: '<p>${name}</p>' },`).join('\n')}
  },
})
`

/**
 * The happy case, end to end: the file tree produced the chain, and the chain produced the plan.
 *
 * The three assertions are the three things a nested layout has to be. It is not a route — the file
 * is a wrapper and a route called `/section/layout` is not what anybody who wrote it meant. Its
 * holes reach the plan indistinguishably from the outer layout's, in document order. And its
 * stylesheet is linked by the pages under it, which is the same rule a component's follows.
 */
test('a layout under routes/ wraps the subtree, and is not a route of its own', async () => {
  const root = await fixture('ok', {
    'app/layout.tsx': OUTER('panel body'),
    'app/routes/index.data.ts': PAGE(['panel', 'body']),
    'app/routes/section/layout.tsx': INNER('toc body'),
    'app/routes/section/layout.css': '.wrap { display: grid }\n',
    'app/routes/section/index.data.ts': PAGE(['panel', 'toc', 'body']),
    'app/routes/section/deep/index.data.ts': PAGE(['panel', 'toc', 'body']),
  })
  try {
    const app = await createApp(root, { mode: 'dev', port: 0 })
    const patterns = app.routes.map((route) => route.pattern).sort()
    assert.deepEqual(patterns, ['/', '/section', '/section/deep'])

    const holes = (pattern: string) => app.routes.find((r) => r.pattern === pattern)?.holes
    assert.deepEqual(holes('/'), ['panel', 'body'], 'a route outside the subtree is untouched')
    assert.deepEqual(
      holes('/section'),
      ['panel', 'toc', 'body'],
      'the nested layout goes where the outer body hole was, so its holes are in document order',
    )
    assert.deepEqual(holes('/section/deep'), ['panel', 'toc', 'body'], 'and to every depth under it')

    const css = (pattern: string) =>
      (app.routes.find((r) => r.pattern === pattern)?.css ?? []).map((file) => file.split('/').pop())
    assert.ok(
      css('/section')?.some((file) => file?.startsWith('layout')),
      css('/section')?.join(','),
    )
    assert.equal(
      css('/')?.some((file) => file?.startsWith('layout') && file !== 'layout.css'),
      false,
      'a page outside the subtree does not link its stylesheet',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('two routes under one nested layout are the same document, and one outside it is not', async () => {
  const root = await fixture('same-document', {
    'app/layout.tsx': OUTER('panel body'),
    'app/routes/index.data.ts': PAGE(['panel', 'body']),
    'app/routes/section/index.data.ts': PAGE(['panel', 'toc', 'body']),
    'app/routes/section/other.data.ts': PAGE(['panel', 'toc', 'body']),
    'app/routes/section/layout.tsx': INNER('toc body'),
  })
  try {
    const app = await createApp(root, { mode: 'dev', port: 0 })
    const shell = (pattern: string) => app.routes.find((r) => r.pattern === pattern)?.shell.version
    assert.equal(shell('/section'), shell('/section/other'))
    assert.notEqual(shell('/'), shell('/section'), 'a different chain is a different document')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a layout with nowhere to put the one inside it is refused, naming both files', async () => {
  const root = await fixture('no-nesting-slot', {
    'app/layout.tsx': OUTER('panel main'),
    'app/routes/section/index.data.ts': PAGE(['panel', 'main']),
    'app/routes/section/layout.tsx': INNER('toc body'),
  })
  try {
    await assert.rejects(createApp(root, { mode: 'dev', port: 0 }), (error: Error) => {
      assert.match(error.message, /E_NO_NESTING_SLOT/)
      assert.match(error.message, /layout\.tsx/)
      return true
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('two layers of one chain leaving the same hole name is refused', async () => {
  const root = await fixture('duplicate-hole', {
    'app/layout.tsx': OUTER('aside body'),
    'app/routes/section/index.data.ts': PAGE(['aside', 'body']),
    'app/routes/section/layout.tsx': INNER('aside body'),
  })
  try {
    await assert.rejects(createApp(root, { mode: 'dev', port: 0 }), (error: Error) => {
      assert.match(error.message, /E_DUPLICATE_LAYOUT_HOLE/)
      assert.match(error.message, /'aside'/)
      return true
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a declaration beside a nested layout is refused: it would be one every route shared', async () => {
  const root = await fixture('layout-data', {
    'app/layout.tsx': OUTER('panel body'),
    'app/routes/section/index.data.ts': PAGE(['panel', 'toc', 'body']),
    'app/routes/section/layout.tsx': INNER('toc body'),
    'app/routes/section/layout.data.ts': PAGE([]),
  })
  try {
    await assert.rejects(createApp(root, { mode: 'dev', port: 0 }), /E_NESTED_LAYOUT_DATA/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a hole in a nested layout that nothing supplies fails the build with that file named', async () => {
  const root = await fixture('unfilled-value', {
    'app/layout.tsx': OUTER('panel body'),
    'app/routes/section/index.data.ts': PAGE(['panel', 'toc', 'body']),
    'app/routes/section/layout.tsx': `import { fragment } from '@weftjs/core'

export default fragment(({ toc, body, subtitle }: { toc: string; body: string; subtitle: string }) => (
  <div class="wrap">
    <p>{subtitle}</p>
    <div><slot name="toc">{toc}</slot></div>
    <div><slot name="body">{body}</slot></div>
  </div>
))
`,
  })
  try {
    await assert.rejects(createApp(root, { mode: 'dev', port: 0 }), (error: Error) => {
      assert.match(error.message, /E_LAYOUT_HOLE_UNFILLED/)
      assert.match(error.message, /subtitle/)
      assert.match(error.message, /routes[/\\]section[/\\]layout\.tsx/)
      return true
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * Scope matching is by segment, and this is the case that says why.
 *
 * `/blog` is not a prefix of `/blogroll` in any sense a router would recognise, and a layout that
 * wrapped the wrong subtree would do it silently, on a page that renders.
 */
test('a scope wraps a route only where every segment matches', () => {
  const nested: DiscoveredNested[] = [
    { scope: '/', file: 'a', depth: 0 },
    { scope: '/blog', file: 'b', depth: 1 },
    { scope: '/blog/:slug', file: 'c', depth: 2 },
  ]
  const scopes = (pattern: string) => chainFor(pattern, nested).map((entry) => entry.scope)

  assert.deepEqual(scopes('/blogroll'), ['/'])
  assert.deepEqual(scopes('/blog'), ['/', '/blog'])
  assert.deepEqual(scopes('/blog/hello'), ['/', '/blog'])
  assert.deepEqual(scopes('/blog/:slug'), ['/', '/blog', '/blog/:slug'], 'outermost first')
})

test('the demo has a nested layout, and its subtree is one document', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const discovered = await discover(root, 'app')
  assert.deepEqual(
    discovered.nested.map((entry) => entry.scope),
    ['/docs'],
  )
  const app = await createApp(root, { mode: 'dev', port: 0 })
  const docs = app.routes.filter((route) => route.pattern.startsWith('/docs'))
  assert.equal(docs.length, 2)
  assert.deepEqual(
    docs.map((route) => route.holes),
    [
      ['panel', 'toc', 'body', 'readout'],
      ['panel', 'toc', 'body', 'readout'],
    ],
  )
  assert.equal(docs[0]?.shell.version, docs[1]?.shell.version)
  assert.notEqual(
    app.routes.find((route) => route.pattern === '/')?.shell.version,
    docs[0]?.shell.version,
    'the index is a different document: it has no nested layout',
  )
})
