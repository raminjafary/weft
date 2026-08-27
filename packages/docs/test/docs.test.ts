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
import { errorBody, errorsIndexBody } from '../app/lib/errors-page.ts'
import { compilePlayground, STARTER } from '../app/lib/play.ts'
import { infer } from '../app/infer.ts'
import { commands, options } from '../app/lib/cli.ts'
import { budgets } from '../app/lib/budgets.ts'
import { drawnDependencies } from '../app/lib/architecture.ts'
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
    // The starter's shape is free to change; what must hold is that it renders an element and that
    // its holes were filled with the values `valuesFor` invented, rather than left empty.
    assert.match(ok.html, /^<[a-z]/, ok.html)
    assert.ok(ok.html.includes('label'), ok.html)
    assert.ok(ok.holes.length >= 2)
    assert.ok(ok.segments >= 2, `${ok.segments} pre-encoded runs`)
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

/**
 * A results page carries the query that produced it.
 *
 * The header's box cannot be pre-filled — `layoutValues` is handed route params and `q` is a query
 * parameter — so before the slot grew one of its own, `/search?q=fragment` showed "52 results for
 * fragment" above an empty input, and refining a search meant retyping it.
 */
test('the search results page comes back with the query still in the box', async () => {
  const serving = await serveApp(await app())
  servers.push(serving)

  const found = await (await fetch(new URL('/search?q=fragment', serving.url))).text()
  assert.match(found, /<input[^>]*name="q"[^>]*value="fragment"/)

  const missing = await (await fetch(new URL('/search?q=zzzqqq', serving.url))).text()
  assert.match(missing, /<input[^>]*name="q"[^>]*value="zzzqqq"/)

  // A quote in the query must not close the attribute it is rendered into.
  const hostile = await (await fetch(new URL('/search?q=a%22+onfocus%3Dalert(1)', serving.url))).text()
  assert.doesNotMatch(hostile, /value="a" onfocus/)
  assert.match(hostile, /value="a&quot; onfocus=alert\(1\)"/)
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

/**
 * The playground's hints run in the browser on every keystroke, which is the one place on this site
 * where an answer is produced by something other than the compiler. So what it may claim is worth
 * gating: it must agree with the compiler about what a hole is called, be conservative where it
 * cannot see a type, and never flag the thing that is certainly correct.
 */
test('the live hints read types, name the holes the compiler names, and admit what they cannot see', () => {
  const source = `import { fragment } from 'weft'

interface Props { label: string; count: number; unit: string }

export default fragment(({ label, count, unit }: Props, ctx) => {
  const who = ctx.user()
  return (
    <span class={label}>{label} <b>{count}</b>{unit}{nope}
      {rows.map((r) => (<p>{r.price}</p>))}
    </span>
  )
})`
  const { hints, reads, cacheClass } = infer(source)
  const by = new Map(hints.map((hint) => [`${hint.binding}:${hint.where}`, hint]))

  // A type that cannot hold markup needs no escaping; everything else is escaped.
  assert.equal(by.get('count:text')?.escape, 'none', 'a number hole needs no escaping')
  assert.equal(by.get('label:text')?.escape, 'text', 'a string hole is escaped')
  assert.equal(by.get('label:attr')?.escape, 'attr', 'the same binding in an attribute escapes as one')

  // A hole after another hole is still a hole. This is the pair a tag-anchored scan misses.
  assert.equal(by.get('unit:text')?.type, 'string', 'a hole following a hole is found')

  // What it cannot see, it says so about — and what it can see is correct, is not flagged.
  assert.equal(by.get('nope:text')?.undeclared, true, 'a binding nothing declares is flagged')
  assert.equal(by.get('label:text')?.undeclared, undefined, 'a declared binding is not flagged')
  assert.equal(by.get('r:text'), undefined, "a row's own parameter is not an undeclared binding")

  // A list is named for the thing being mapped, which is what the compiler calls the hole.
  assert.equal(by.get('rows:list')?.where, 'list')

  // An import specifier and a destructured parameter read exactly like a text hole to a scan.
  assert.equal(by.get('fragment:text'), undefined, 'an import specifier is not a hole')
  assert.equal(by.get('Props:text'), undefined, 'a type annotation is not a hole')

  assert.ok(
    reads.some((read) => read.taint === 'identity'),
    'reading identity is a read',
  )
  assert.equal(cacheClass, 'private', 'a fragment that reads identity is private, never shared')
})

/**
 * A block whose body is a hole escapes it, which is the whole reason those bodies became holes —
 * and the whole reason a caller must not write markup into one.
 *
 * It went wrong exactly once and was invisible until somebody read the page: a note on the error
 * index carried `<strong>327</strong>`, and the compiler did its job and printed the tags. There is
 * no way for the fragment to tell the difference between markup somebody meant and markup somebody
 * forgot, so the check has to be here, on the values.
 *
 * Two things are deliberately not checked. Prose goes through `raw` in `fragments/docs/page.tsx`
 * and carries this repository's own inline markup on purpose — 179 inline tags' worth. And a table
 * cell holds extracted data, where an angle bracket is usually the point: eight of the framework's
 * own refusal messages quote a `<slot name="body">` at you, and a cell that escapes one is a cell
 * doing its job. What is checked is authored text — a note, a heading — where a tag can only be
 * somebody having forgotten which side of the compiler they were on.
 */
test('nothing that reaches a hole carries markup, because a hole escapes it', () => {
  const offenders: string[] = []
  const check = (where: string, value: string) => {
    if (/<\/?[a-z][a-z0-9]*[\s/>]/i.test(value)) offenders.push(`${where}: ${value.slice(0, 60)}…`)
  }
  for (const block of errorsIndexBody()) {
    if (block.isNote) {
      check('errors index note title', block.title)
      check('errors index note body', block.body)
    }
    if (block.isHeading) check('errors index heading', block.text)
  }
  for (const code of ['E_ETAG_STREAMS', 'E_NO_ROUTE_FILE']) {
    for (const block of errorBody(code)) {
      if (block.isNote) {
        check(`${code} note title`, block.title)
        check(`${code} note body`, block.body)
      }
      if (block.isHeading) check(`${code} heading`, block.text)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'a hole escapes its value, so markup written into one reaches the reader as tags',
  )
})

/**
 * A layout may carry a conditional, and this is the page that proves it end to end.
 *
 * It could not, briefly, and the failure was invisible: cutting a shell at its slots resolved no
 * derived values, so `{section ? … : …}` in a layout wrote nothing and nothing refused. The
 * workaround was to decide a whole class name on the route's side and hide the trail with CSS —
 * which is markup that lies about what is on the page. So this asserts the two states of the
 * conditional itself: a guide *page* is inside a group and draws a trail through it, and the
 * guide's index is not inside anything and draws none.
 */
test('a section layout draws its breadcrumb only on the pages that are inside something', async () => {
  const serving = await serveApp(await app())
  servers.push(serving)

  const page = await (await fetch(new URL('/guide/intents', serving.url))).text()
  assert.match(page, /class="crumbs"/, 'a guide page is inside a group, so it draws a trail')
  assert.match(page, /<a href="\/guide">Guide<\/a>/, page.slice(0, 200))
  assert.ok(
    page.includes('Change'),
    'the middle crumb is the group the page is in, which the route derives rather than states twice',
  )

  const index = await (await fetch(new URL('/guide', serving.url))).text()
  assert.ok(
    !index.includes('class="crumbs"'),
    'the index is not inside anything, so the branch writes no nav at all — not a hidden one',
  )
})

/**
 * The mark is a component the document composes, which is a thing a layout could not do.
 *
 * A component instance inside a layout rendered nothing at all: the shell splitter reached the arm
 * that writes zero bytes for a component, and a hole that writes nothing is indistinguishable from
 * a hole whose value was empty. So this checks the bytes rather than the declaration.
 */
test('the document composes the mark, and the mark reaches the page', async () => {
  const serving = await serveApp(await app())
  servers.push(serving)
  const home = await (await fetch(new URL('/', serving.url))).text()
  assert.match(home, /<a class="brand" href="\/"><svg class="mark"/, home.slice(0, 400))
  assert.match(home, /class="mark-warp"/, 'both threads of the mark, from the composed template')
  assert.match(home, /class="mark quiet"/, 'and the footer instance, at its own size and tone')
})

/**
 * The architecture diagram draws fifteen arrows, and every one of them is a real dependency.
 *
 * A diagram is the one kind of documentation nobody re-reads. Prose about a dependency that moved
 * reads wrong to somebody who knows the code; a *line* between two boxes reads fine forever, which
 * is what makes a stale diagram worse than none. So the arrows are checked against the manifests
 * that would have to declare them, and a dependency that goes away fails this instead of quietly
 * becoming a lie on the front page of the guide.
 */
test('every arrow on the architecture diagram is a dependency some package.json declares', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const declared = new Map<string, Set<string>>()
  for (const name of readdirSync(join(root, 'packages'))) {
    const manifest = join(root, 'packages', name, 'package.json')
    if (!existsSync(manifest)) continue
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
      name: string
      dependencies?: Record<string, string>
    }
    declared.set(parsed.name, new Set(Object.keys(parsed.dependencies ?? {})))
  }
  const drawn = drawnDependencies()
  assert.ok(drawn.length > 10, 'the figure still draws a graph')
  for (const [dependent, on] of drawn) {
    const deps = declared.get(dependent)
    assert.ok(deps, `${dependent} is drawn on the architecture figure but is not a package any more`)
    assert.ok(
      deps.has(on),
      `the architecture figure draws ${dependent} → ${on}, and ${dependent}/package.json no longer declares it`,
    )
  }
})

/**
 * The wave figure is the kernel's own scheduler, run on the slots the figure names.
 *
 * Which is the only reason it is allowed to state 42.7 ms: the number is not transcribed from the
 * kernel's README, it is what `criticalPath` returns for those nine slots. This asserts the two
 * agree, so a scheduling change moves the diagram or fails here.
 */
test('the wave diagram is scheduled rather than drawn', async () => {
  const serving = await serveApp(await app())
  servers.push(serving)
  const page = await (await fetch(new URL('/guide', serving.url))).text()
  assert.match(page, /42\.7 ms/, 'the critical path the kernel computes')
  assert.match(page, /123\.3 ms/, 'against the sequential walk it did not take')
  assert.match(page, /@keyframes wf-g8\{/, 'and nine keyframes generated from those durations')
})
