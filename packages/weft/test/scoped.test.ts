import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discover } from '../src/convention.ts'
import { compileApp } from '../src/compile.ts'
import { render } from '@weftjs/ir'
import { isScopedSheet, scopeAttribute, scopeCss, scopeStem } from '../src/scoped.ts'

/**
 * Scoped stylesheets.
 *
 * Two halves that have to agree without being told to: the compiler stamps an attribute derived
 * from a file's stem, and the stylesheet beside it derives the same attribute on its own. So the
 * first test here is that the two halves land on the same string, and the rest is the selector
 * transform — which is where a mistake is silent, because a selector that is narrowed wrongly still
 * parses and still applies to something.
 */

test('a stem derives one attribute, whichever half asks for it', () => {
  const fromTemplate = scopeAttribute(scopeStem('app/fragments/card.tsx'))
  const fromSheet = scopeAttribute(scopeStem('app/fragments/card.scoped.css'))
  assert.equal(fromTemplate, fromSheet)
  assert.match(fromTemplate, /^data-w-[0-9a-f]{8}$/)
})

test('two components never share an attribute, and a path separator does not decide one', () => {
  assert.notEqual(scopeAttribute('app/fragments/card'), scopeAttribute('app/fragments/note'))
  assert.equal(scopeAttribute('app\\fragments\\card'), scopeAttribute('app/fragments/card'))
})

test('the attribute joins the last compound, and nothing before it', () => {
  const out = scopeCss('.row .cell { color: red }', 'data-w-x')
  assert.equal(out, '.row .cell[data-w-x] { color: red }')
})

test('a pseudo-class filters the compound, so the attribute goes in front of it', () => {
  assert.equal(scopeCss('.card:hover { }', 'data-w-x'), '.card[data-w-x]:hover { }')
  assert.equal(scopeCss('.card::after { }', 'data-w-x'), '.card[data-w-x]::after { }')
  assert.equal(scopeCss('a > b + c ~ d { }', 'data-w-x'), 'a > b + c ~ d[data-w-x] { }')
})

test('every selector in a list is narrowed, and a comma inside :is() is not one', () => {
  assert.equal(scopeCss('.a, .b { }', 'data-w-x'), '.a[data-w-x], .b[data-w-x] { }')
  assert.equal(scopeCss(':is(.a, .b) .c { }', 'data-w-x'), ':is(.a, .b) .c[data-w-x] { }')
})

test('an existing attribute selector is not mistaken for the scope', () => {
  const out = scopeCss("a[href^='/x'] .deep { }", 'data-w-x')
  assert.equal(out, "a[href^='/x'] .deep[data-w-x] { }")
})

/**
 * The at-rule split is the part worth testing hardest: `@media` holds selectors and `@keyframes`
 * holds percentages that look exactly like selectors to a tokeniser. Narrowing a keyframe stop
 * produces `0%[data-w-x]`, which parses, never matches, and silently kills the animation.
 */
test('at-rules that hold selectors recurse, and the ones that do not are left alone', () => {
  assert.equal(
    scopeCss('@media (max-width: 500px) { .card { padding: 0 } }', 'data-w-x'),
    '@media (max-width: 500px) { .card[data-w-x] { padding: 0 } }',
  )
  assert.equal(
    scopeCss('@keyframes spin { 0% { opacity: 0 } to { opacity: 1 } }', 'data-w-x'),
    '@keyframes spin { 0% { opacity: 0 } to { opacity: 1 } }',
  )
  assert.equal(
    scopeCss("@import url('x.css');\n.a { }", 'data-w-x'),
    "@import url('x.css');\n.a[data-w-x] { }",
  )
})

test('a brace inside a string or a comment does not open a block', () => {
  assert.equal(scopeCss('.a::after { content: "{" }', 'data-w-x'), '.a[data-w-x]::after { content: "{" }')
  assert.equal(scopeCss('/* .b { } */\n.a { }', 'data-w-x'), '/* .b { } */\n.a[data-w-x] { }')
})

test('a sheet comes back with its own formatting, not a reflowed one', () => {
  const source = '.a {\n  color: red;\n}\n\n.b {\n  color: blue;\n}\n'
  const out = scopeCss(source, 'data-w-x')
  assert.equal(out, '.a[data-w-x] {\n  color: red;\n}\n\n.b[data-w-x] {\n  color: blue;\n}\n')
})

test('a file is scoped by its name and by nothing else', () => {
  assert.equal(isScopedSheet('app/fragments/card.scoped.css'), true)
  assert.equal(isScopedSheet('app/fragments/card.css'), false)
})

async function scratch(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'weft-scoped-'))
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, body)
  }
  return root
}

const CARD = `import { fragment } from '@weftjs/core'

interface Props {
  title: string
}

export default fragment(({ title }: Props) => (
  <div class="card">
    <h3 class="title">{title}</h3>
  </div>
))
`

const PAGE = `import { fragment } from '@weftjs/core'
import Card from '../fragments/card.tsx'

export default fragment(() => (
  <main class="card">
    <Card title="hello" />
  </main>
))
`

/**
 * The end of the feature, checked on real files: a fragment with a scoped sheet stamps its own
 * elements, and the page that renders it does not get the attribute on an element of its own that
 * happens to carry the same class. That second half is the whole point — without it, scoping is
 * just a longer selector.
 */
test('a scoped fragment stamps its own elements, and only its own', async () => {
  const root = await scratch({
    'package.json': '{"name":"scoped-fixture","private":true,"type":"module"}',
    'app/fragments/card.tsx': CARD,
    'app/fragments/card.scoped.css': '.card { border: 1px solid red }\n',
    'app/routes/index.tsx': PAGE,
  })
  const discovered = await discover(root)
  const compiled = await compileApp(discovered, { outDir: '.weft', types: false })

  const card = compiled.fragments['fragment:card']
  const page = compiled.fragments['route:/']
  assert.ok(card && page)

  const attribute = scopeAttribute('app/fragments/card')
  const cardHtml = new TextDecoder().decode(render(card.entry, { title: 'hello' }, card.resolve))
  assert.match(cardHtml, new RegExp(`<div ${attribute} class="card"`))
  assert.match(cardHtml, new RegExp(`<h3 ${attribute} class="title"`))

  const pageHtml = new TextDecoder().decode(render(page.entry, {}, page.resolve))
  assert.ok(
    !pageHtml.includes(`<main ${attribute}`),
    'the page has its own <main class="card">; a scope that reached it would style a component it does not own',
  )
})

test('an unscoped fragment stamps nothing at all', async () => {
  const root = await scratch({
    'package.json': '{"name":"unscoped-fixture","private":true,"type":"module"}',
    'app/fragments/card.tsx': CARD,
    'app/fragments/card.css': '.card { border: 1px solid red }\n',
    'app/routes/index.tsx': PAGE,
  })
  const discovered = await discover(root)
  const compiled = await compileApp(discovered, { outDir: '.weft', types: false })
  const card = compiled.fragments['fragment:card']
  assert.ok(card)
  const html = new TextDecoder().decode(render(card.entry, { title: 'x' }, card.resolve))
  assert.ok(!html.includes('data-w-'))
})

test('a scoped sheet with no template beside it is refused by name', async () => {
  const root = await scratch({
    'package.json': '{"name":"orphan-fixture","private":true,"type":"module"}',
    'app/routes/index.data.ts': 'export default { }\n',
    'app/routes/index.scoped.css': '.a { color: red }\n',
  })
  await assert.rejects(() => discover(root), /E_SCOPED_NO_TEMPLATE/)
})
