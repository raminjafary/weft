import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp, serveApp, type Serving } from 'weft/server'
import { after } from 'node:test'
import { renderExample } from '../app/lib/example.ts'
import { PAGES } from '../app/lib/pages.ts'
import { written } from '../app/lib/content.ts'
import { SECTIONS } from '../app/lib/sections.ts'
import { STEPS } from '../app/lib/tutorial.ts'
import { TERMS } from '../app/lib/glossary.ts'
import { surface } from '../app/lib/surface.ts'
import { errorCodes } from '../app/lib/errors.ts'
import { compilePlayground, STARTER } from '../app/lib/play.ts'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const REPO = fileURLToPath(new URL('../../../', import.meta.url))

let built: Awaited<ReturnType<typeof createApp>> | null = null
const servers: Serving[] = []

async function app(): Promise<NonNullable<typeof built>> {
  built ??= await createApp(ROOT, { mode: 'dev', port: 0 })
  return built
}

after(async () => {
  for (const serving of servers) await serving.close()
})

/**
 * The promise this site makes is that every example on it is live: a fragment this application
 * compiled, rendered by the same renderer as the rest of the page. That is only a promise if it is
 * checked, so this renders all of them. A `renderExample` that threw would be a page with an empty
 * box on it, which is the one thing a documentation site must not be able to do quietly.
 */
test('every example in the registry compiles and renders', async () => {
  await app()
  const examples = PAGES.flatMap((page) => page.examples)
  assert.ok(examples.length >= 6, `only ${examples.length} examples: the site claims more than that`)
  for (const example of examples) {
    const rendered = renderExample(example)
    assert.ok(rendered.html.length > 0, `${example.id} rendered nothing`)
    assert.ok(rendered.source.length > 0, `${example.id} carries no source`)
    assert.ok(rendered.facts.version.length > 0, `${example.id} has no sealed version`)
    assert.match(rendered.file, /app[/\\]fragments[/\\]examples[/\\]/, rendered.file)
  }
})

test('every example fragment on disk is used by a page', () => {
  const dir = join(ROOT, 'app/fragments/examples')
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.tsx'))
    .map((name) => `examples/${name.replace(/\.tsx$/, '')}`)
  const used = new Set(PAGES.flatMap((page) => page.examples.map((example) => example.id)))
  assert.deepEqual(
    files.filter((id) => !used.has(id)),
    [],
    'an example fragment nothing links to: it is compiled on every build and read by nobody',
  )
})

test('every guide page has prose, and every prose page is in the registry', () => {
  const slugs = PAGES.map((page) => page.slug).sort()
  assert.deepEqual(written().sort(), slugs, 'a page in the registry with no content is an empty box')
})

test('no page, and no glossary entry, points at something that does not exist', async () => {
  const { routes } = await app()
  const matches = (href: string): boolean => {
    const path = href.split('#')[0] as string
    return routes.some((route) => {
      const source = route.pattern
        .split('/')
        .map((segment) => (segment.startsWith(':') ? '[^/]+' : segment === '*' ? '.*' : segment))
        .join('/')
      return new RegExp(`^${source}$`).test(path)
    })
  }

  for (const section of SECTIONS) assert.ok(matches(section.href), `section ${section.href} is not a route`)
  for (const term of TERMS) {
    for (const link of term.see ?? []) assert.ok(matches(link.href), `${term.term} links to ${link.href}`)
  }
  for (const page of PAGES) {
    for (const doc of page.covers) {
      assert.ok(
        existsSync(join(REPO, 'spec', doc)),
        `${page.slug} says it introduces spec/${doc}, which does not exist`,
      )
    }
  }
})

/**
 * The API reference is generated, so the interesting failure is not that it is wrong — it is that
 * the walk missed something. This checks it against the module system: every name a package actually
 * exports at runtime has to appear on its page.
 *
 * Types cannot be checked this way, because they do not exist at runtime. What that leaves uncovered
 * is an interface the walker failed to follow, and the count assertion below is the guard against a
 * whole file dropping out.
 */
test('every runtime export of every package appears in the API reference', async () => {
  const specifiers: Record<string, string> = {
    weft: 'weft',
    'weft-server': 'weft/server',
    kernel: '@weft/kernel',
    plan: '@weft/plan',
    ir: '@weft/ir',
    warp: '@weft/warp',
    client: '@weft/client',
    compiler: '@weft/compiler',
    adapters: '@weft/adapters',
  }
  for (const module of surface()) {
    const specifier = specifiers[module.id]
    if (!specifier) continue
    let loaded: Record<string, unknown>
    try {
      loaded = (await import(specifier)) as Record<string, unknown>
    } catch {
      // A package this application does not depend on cannot be imported from here, and the walk
      // does not need it to. Skipped by name rather than silently passing.
      continue
    }
    const documented = new Set(module.entries.map((entry) => entry.name))
    const missing = Object.keys(loaded).filter((name) => name !== 'default' && !documented.has(name))
    assert.deepEqual(missing, [], `${specifier} exports these and the API page does not list them`)
  }
})

test('the API reference covers every module, and none of them is empty', () => {
  const modules = surface()
  assert.equal(modules.length, 9)
  for (const module of modules) {
    assert.ok(
      module.entries.length > 10,
      `${module.specifier} produced only ${module.entries.length} entries`,
    )
    assert.ok(module.blurb.length > 40, `${module.specifier} has no blurb`)
    for (const entry of module.entries) {
      assert.ok(entry.signature.startsWith('export '), `${entry.name}: ${entry.signature.slice(0, 40)}`)
      assert.ok(entry.file.startsWith('packages/'), entry.file)
    }
  }
  const total = modules.reduce((sum, module) => sum + module.entries.length, 0)
  assert.ok(total > 800, `only ${total} exports found: the walk lost something`)
})

/**
 * The error reference is generated too, so this scans the same tree independently — a plain regular
 * expression over every `src` file — and fails if a code exists in the framework and not on the
 * page. A filter that quietly dropped a package would otherwise look like a complete reference.
 */
test('every named refusal in the framework is in the error reference', () => {
  const listed = new Set(errorCodes().map((entry) => entry.code))
  const found = new Set<string>()
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist') continue
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (name.endsWith('.ts') || name.endsWith('.tsx')) {
        for (const match of readFileSync(path, 'utf8').matchAll(/\b[EW]_[A-Z][A-Z0-9_]*\b/g)) {
          found.add(match[0])
        }
      }
    }
  }
  const packages = join(REPO, 'packages')
  for (const pkg of readdirSync(packages)) {
    const src = join(packages, pkg, 'src')
    if (existsSync(src)) walk(src)
  }
  assert.ok(found.size > 300, `only ${found.size} codes found by the independent scan`)
  assert.deepEqual(
    [...found].filter((code) => !listed.has(code)).sort(),
    [],
    'a code the framework raises that the error reference does not list',
  )
})

test('every code in the reference names a real file, and most carry a message', () => {
  const all = errorCodes()
  for (const entry of all) {
    assert.ok(entry.sites.length > 0, `${entry.code} has no site`)
    for (const site of entry.sites) {
      assert.ok(existsSync(join(REPO, site.file)), `${entry.code} points at ${site.file}`)
      assert.ok(site.line > 0)
    }
  }
  const withMessage = all.filter((entry) => entry.message).length
  // A floor rather than a target. The codes with no message throw nothing but themselves, which the
  // page says out loud; this keeps the extraction from silently getting worse.
  assert.ok(
    withMessage / all.length > 0.75,
    `only ${withMessage} of ${all.length} codes have an extractable message`,
  )
})

test('the tutorial is a sequence, and every step has a body', () => {
  assert.ok(STEPS.length >= 6)
  for (const step of STEPS) {
    const html = step.body()
    assert.ok(html.length > 400, `${step.slug} is too short to be a step`)
    assert.ok(html.includes('<p>'), `${step.slug} has no prose`)
  }
})

test('the playground compiles its own starter, and refuses by name', async () => {
  const ok = await compilePlayground(STARTER)
  assert.equal(ok.ok, true, JSON.stringify(ok))
  if (ok.ok) {
    assert.ok(ok.html.includes('<article'), ok.html)
    assert.ok(ok.holes.length >= 2)
    assert.ok(
      ok.holes.every((hole) => hole.escape === 'escape'),
      'a virtual compile has no checker, so every hole escapes — and the page says so',
    )
  }

  const empty = await compilePlayground('   ')
  assert.equal(empty.ok, false)

  const notAFragment = await compilePlayground('export default 3')
  assert.equal(notAFragment.ok, false)
  if (!notAFragment.ok) assert.match(notAFragment.code, /^E_/)

  const tooBig = await compilePlayground('x'.repeat(9000))
  assert.equal(tooBig.ok, false)
  if (!tooBig.ok) assert.equal(tooBig.code, 'E_TOO_LARGE')
})

/** Every page answers, and none of them answers with a stack trace. */
test('every route in the site serves a document', async () => {
  const serving = await serveApp(await app())
  servers.push(serving)
  const paths = [
    '/',
    '/quick-start',
    '/guide',
    ...PAGES.map((page) => `/guide/${page.slug}`),
    '/tutorial',
    ...STEPS.map((step) => `/tutorial/${step.slug}`),
    '/examples',
    '/api',
    ...surface().map((module) => `/api/${module.id}`),
    '/glossary',
    '/errors',
    '/errors/E_NO_SHELL',
    '/play',
  ]
  for (const path of paths) {
    const response = await fetch(new URL(path, serving.url))
    const html = await response.text()
    assert.equal(response.status, 200, `${path} answered ${response.status}`)
    assert.ok(html.includes('</html>'), `${path} did not finish its document`)
    assert.equal(html.includes('E_DOCS_NO_BODY'), false, `${path} has a page with no content written`)
    assert.equal(html.includes('at Object.'), false, `${path} rendered a stack trace`)
  }
})
