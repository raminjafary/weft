import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp, serveApp, type Serving } from 'weft/server'
import { after } from 'node:test'
import { renderExample } from '../app/lib/example.ts'
import { PAGES } from '../app/lib/pages.ts'
import { bodyOf, headingsOf, written } from '../app/lib/content.ts'
import { SECTIONS } from '../app/lib/sections.ts'
import { STEPS } from '../app/lib/tutorial.ts'
import { TERMS } from '../app/lib/glossary.ts'
import { surface } from '../app/lib/surface.ts'
import { errorCodes } from '../app/lib/errors.ts'
import { compilePlayground, STARTER } from '../app/lib/play.ts'
import { commands, options } from '../app/lib/cli.ts'
import { budgets } from '../app/lib/budgets.ts'
import { artifacts } from '../app/lib/versions.ts'
import { indexSize, search } from '../app/lib/search.ts'
import { wireSizes } from '../app/lib/wire.ts'

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
  assert.ok(examples.length >= 14, `only ${examples.length} examples: the site claims more than that`)
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

/**
 * Every export carries a doc comment on its declaration.
 *
 * This was a published ratio before it was a gate — 384 of 1,367 — because a blank space a reader
 * mistakes for a simple function is worse than an admission. The ratio is now 1, so the assertion is
 * equality rather than a floor: a new export without a comment fails here, which is the only way a
 * number like this stays at one.
 */
test('every export in the API reference has a doc comment', () => {
  const undocumented = surface().flatMap((module) =>
    module.entries.filter((entry) => !entry.doc).map((entry) => `${module.specifier} ${entry.name}`),
  )
  assert.deepEqual(undocumented, [], 'an export with no doc comment on its declaration')
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
        const text = readFileSync(path, 'utf8')
        for (const match of text.matchAll(/\b[EW]_[A-Z][A-Z0-9_]*\b/g)) {
          // `E_INTENT_${response.status}` builds a name at runtime; the prefix is not a code, and
          // the reference skips it for the same reason.
          if (text.startsWith('${', (match.index ?? 0) + match[0].length)) continue
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
  // Not a floor: zero. Every refusal in the framework either carries a sentence of its own or
  // forwards the failure underneath it, and a code that says nothing at all is the one state this
  // gate exists to keep at nothing.
  const silent = all.filter((entry) => entry.detail === 'none')
  assert.deepEqual(
    silent.map((entry) => `${entry.code} at ${entry.sites[0]?.file}`),
    [],
    'a refusal that says nothing but its own name',
  )
  const prose = all.filter((entry) => entry.detail === 'prose').length
  assert.ok(prose / all.length > 0.95, `only ${prose} of ${all.length} codes carry their own sentence`)
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

/**
 * The other direction of the `covers` relation, and the one that makes the guide's coverage a gate.
 *
 * A page naming a document that does not exist has always failed here. This fails when a document
 * exists and no page introduces it — which is the failure that actually happens: a mechanism ships,
 * its spec is written, and the site quietly stays a description of the framework as it was. There is
 * no exemption list on purpose; a document worth writing is a document worth a paragraph a reader can
 * find.
 */
test('every spec document is introduced by a guide page', () => {
  const specs: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path, `${prefix}${name}/`)
      else if (name.endsWith('.md')) specs.push(`${prefix}${name}`)
    }
  }
  walk(join(REPO, 'spec'), '')
  const covered = new Set(PAGES.flatMap((page) => page.covers))
  assert.deepEqual(
    specs.filter((doc) => !covered.has(doc)),
    [],
    'a spec document no page on this site introduces',
  )
  assert.ok(specs.length > 20, `only ${specs.length} spec documents found: the walk lost something`)
})

/** Every page's outline comes from its own headings, so a page with none has an empty column. */
test('every guide page has sections, and every section has an id', () => {
  for (const page of PAGES) {
    const headings = headingsOf(page.slug)
    assert.ok(headings.length > 0, `${page.slug} has no headings: its outline column would be empty`)
    for (const heading of headings) {
      assert.match(heading.id, /^[a-z0-9-]+$/, `${page.slug}: ${heading.id}`)
      assert.ok(heading.text.length > 2, `${page.slug}: a heading with no text`)
    }
  }
})

/**
 * The CLI page is parsed out of the help text, so the failure worth catching is a command that is
 * implemented and not in the help text at all — undocumented in both places at once.
 */
test('every command the CLI implements is on the CLI page', () => {
  const source = readFileSync(join(REPO, 'packages/weft/src/cli.ts'), 'utf8')
  const implemented = new Set(
    [...source.matchAll(/command === '([a-z-]+)'/g)].map((match) => match[1] as string),
  )
  implemented.delete('help')
  const documented = new Set(commands().map((command) => command.name))
  assert.deepEqual(
    [...implemented].filter((name) => !documented.has(name)).sort(),
    [],
    'a command the CLI dispatches and the page does not list',
  )
  assert.ok(commands().length >= 9, `only ${commands().length} commands parsed`)
  // A usage line carries `<name>` and `<n>`, and text lifted out of a source file is text: unescaped,
  // the browser eats `<name>` as a tag and the page shows `weft create` with nothing after it.
  const rendered = bodyOf('cli')
  assert.match(rendered, /weft create &lt;name&gt;/, 'the CLI table is not escaping its own angle brackets')
  assert.match(rendered, /--port &lt;n&gt;/, 'the options table is not escaping its own angle brackets')
  assert.ok(options().length >= 10, `only ${options().length} options parsed`)
  for (const command of commands()) assert.ok(command.summary.length > 8, command.name)
})

/** The generated tables on two pages: parsed from source, so a parse that lost rows is the bug. */
test('the budget and version tables are read out of the source', () => {
  const all = budgets()
  assert.ok(all.length >= 15, `only ${all.length} byte budgets parsed`)
  for (const budget of all) {
    assert.ok(budget.limit >= 1024, `${budget.id} has an implausible ceiling`)
    assert.ok(budget.note.length > 10, `${budget.id} has no note`)
  }

  const stamped = artifacts()
  assert.equal(stamped.length, 3)
  for (const artifact of stamped) {
    assert.match(artifact.version, /^\d+\.\d+\.\d+$/, artifact.what)
    assert.match(artifact.spec, /^weft\./, artifact.what)
  }
  // The published table in the spec is the copy that drifted once. Checked here so it cannot again.
  const versioning = readFileSync(join(REPO, 'spec/VERSIONING.md'), 'utf8')
  for (const artifact of stamped) {
    assert.ok(
      new RegExp(`\`${artifact.spec.replace('/', '\\/')}\`\\s*\\|\\s*${artifact.version}`).test(versioning),
      `spec/VERSIONING.md does not say ${artifact.spec} is ${artifact.version}`,
    )
  }
})

/**
 * The three wire forms of one region, measured rather than quoted.
 *
 * The ordering is the claim the page makes, so the test is the ordering: a delta is smaller than a
 * patch and a patch is smaller than the region. If a change to the renderer ever inverted that, the
 * page would be making a false claim in a table it generated itself.
 */
test('the wire forms measured on the page rank the way the page says', () => {
  const sizes = new Map(wireSizes().map((size) => [size.form, size.bytes]))
  const html = sizes.get('html') ?? 0
  const patch = sizes.get('patch') ?? 0
  const delta = sizes.get('delta') ?? 0
  assert.ok(html > 0 && patch > 0 && delta > 0, JSON.stringify([...sizes]))
  assert.ok(delta < patch, `delta ${delta} is not smaller than patch ${patch}`)
  assert.ok(patch < html, `patch ${patch} is not smaller than html ${html}`)
})

/** Search is a function of the site's own registries, so it can be tested without serving a page. */
function hit(query: string, href: string): void {
  const results = search(query)
  assert.ok(
    results.some((result) => result.href === href),
    `${query} did not find ${href}; got ${results
      .slice(0, 4)
      .map((result) => result.href)
      .join(', ')}`,
  )
}

test('search finds a page, a section, a term, an error and an export', () => {
  assert.ok(indexSize() > 800, `only ${indexSize()} things indexed`)
  hit('intents', '/guide/intents')
  hit('instant navigation', '/guide/navigation')
  hit('E_NO_SHELL', '/errors/E_NO_SHELL')
  hit('defineRoute', '/api/weft#defineRoute')
  hit('adoption', '/glossary#adoption')
  hit('playground', '/play')

  assert.deepEqual(search(''), [], 'an empty query is the empty state, not every page')
  assert.deepEqual(search('zzzqqq'), [], 'a query that matches nothing matches nothing')
})

/**
 * Every name a sketch imports from this framework is a name this framework exports.
 *
 * A sketch is labelled "not compiled", and that label is about the surrounding code — not a licence
 * for the API in it to be fictional. Three of these were wrong when this test was written: two
 * sketches called `intent()` from `weft`, which exports `defineIntent`, and a config sketch imported
 * `workerPool` from `weft`, which does not re-export it. All three read as true, which is exactly
 * what makes them worse than a compile error.
 *
 * Checked against `surface()` rather than by importing each module, because the API walk already
 * knows every export of every package — including the ones this application does not depend on, and
 * including the types, which a dynamic import cannot see.
 */
test('every framework name a sketch imports actually exists', () => {
  const exported = new Map(
    surface().map((module) => [module.specifier, new Set(module.entries.map((entry) => entry.name))]),
  )
  const files = ['app/lib/content.ts', 'app/lib/tutorial.ts', 'app/lib/play.ts', 'app/lib/glossary.ts']
  let found = 0

  for (const file of files) {
    const source = readFileSync(join(ROOT, file), 'utf8')
    for (const match of source.matchAll(/import \{([^}]*)\} from '(weft(?:\/server)?|@weft\/[a-z]+)'/g)) {
      const specifier = match[2] as string
      const names = exported.get(specifier)
      assert.ok(names, `a sketch imports from '${specifier}', which the API walk does not cover`)
      const imported = (match[1] as string)
        .split(',')
        .map((name) => name.trim().replace(/^type /, ''))
        .filter((name) => name.length > 0)
      found += imported.length
      assert.deepEqual(
        imported.filter((name) => !names.has(name)).sort(),
        [],
        `a sketch imports these from '${specifier}' and it does not export them`,
      )
    }
  }
  assert.ok(found > 8, `only ${found} imported names found: the scan lost something`)
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
    '/search',
    '/search?q=slot',
    '/search?q=zzzqqq',
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

/**
 * The one mutation this site declares, dispatched the way a reader without JavaScript would.
 *
 * The intents page shows a form posting to `/_weft/i/docs.helpful`, and a form on a documentation
 * site that 404s would be the worst kind of example: one that reads as true. So this presses it.
 */
test('the intent on the intents page is dispatchable', async () => {
  const serving = await serveApp(await app())
  servers.push(serving)
  const response = await fetch(new URL('/_weft/i/docs.helpful', serving.url), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: 'page=intents',
    redirect: 'manual',
  })
  assert.ok(response.status < 400, `the intent answered ${response.status}`)
  await response.arrayBuffer()

  const refused = await fetch(new URL('/_weft/i/docs.helpful', serving.url), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: 'page=NOT A SLUG',
    redirect: 'manual',
  })
  assert.equal(refused.status, 422, 'a payload the intent refuses should be a 422, not a 500')
  await refused.arrayBuffer()
})
