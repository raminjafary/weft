import { basename } from 'node:path'
import type { CacheSpec, FormSpec, RefreshSpec, SlotBudgetSpec, SlotSpec } from '@weft/plan'
import { cacheClassOf, type Hole } from '@weft/ir'
import type { App } from '../serve.ts'
import { bytes, code, escape, list, maybe, pre, refusal, section, table, type Shell } from './html.ts'
import { byteReport, fragmentReport, routeReport, whyPage, type RouteReport, type WhyPage } from './report.ts'
import type { Ports } from '@weft/kernel'

/**
 * The six pages, each one a rendering of a report and never a derivation of its own.
 *
 * A page here decides what to put beside what. It does not decide what is true — the moment a
 * page computed something for itself it would be able to contradict the build, and a devtool
 * that contradicts the thing it is inspecting is worse than no devtool.
 */
function cacheOf(spec: CacheSpec | undefined): string {
  if (!spec) return '<span class="none">—</span>'
  const parts: string[] = [spec.class]
  if (spec.ttlMs !== undefined) parts.push(`ttl ${spec.ttlMs}ms`)
  if (spec.staleWhileRevalidateMs !== undefined) parts.push(`swr ${spec.staleWhileRevalidateMs}ms`)
  if (spec.consistency) parts.push(spec.consistency)
  if (spec.tags?.length) parts.push(`tags ${spec.tags.join(',')}`)
  return code(parts.join(' · '))
}

function budgetOf(spec: SlotBudgetSpec | undefined): string {
  if (!spec) return '<span class="none">—</span>'
  const parts: string[] = []
  if (spec.cpuMs !== undefined) parts.push(`cpu ${spec.cpuMs}ms`)
  if (spec.jsBytes !== undefined) parts.push(`js ${spec.jsBytes}B`)
  if (spec.growBytes !== undefined) parts.push(`grow ${spec.growBytes}B`)
  if (spec.onExceed) parts.push(`onExceed ${spec.onExceed}`)
  return code(parts.join(' · '))
}

function refreshOf(spec: RefreshSpec | undefined): string {
  if (!spec) return '<span class="none">—</span>'
  return code(`every ${spec.everyMs}ms${spec.when ? ` when ${spec.when.all.join('+')}` : ''}`)
}

function formOf(spec: FormSpec | undefined): string {
  if (!spec) return '<span class="none">—</span>'
  return code([spec.prefer, spec.fallback && `fallback ${spec.fallback}`].filter(Boolean).join(' · '))
}

function deliveryOf(spec: SlotSpec): string {
  return code(spec.delivery === 'stream' ? `stream prio ${spec.prio}` : 'buffered')
}

export function overview(app: App, root: string): Shell {
  const fragmentCount = Object.keys(app.compiled.fragments).length
  const configured = table(
    ['what', 'value'],
    [
      ['project', code(app.config.root)],
      ['config', app.config.file ? code(app.config.file) : '<span class="none">none — every default</span>'],
      ['source', code(`${app.config.srcDir}/`)],
      ['build output', code(`${app.config.outDir}/`)],
      ['listening', code(`${app.config.host}:${app.config.port}`)],
      ['channel', code(app.config.channelPath)],
      ['session cookie', code(app.config.session.cookie)],
      [
        'store',
        app.config.store ? code('bound in weft.config.ts') : code('in-process default — one process, 64 MB'),
      ],
      ['flag axes', list(Object.keys(app.config.flags))],
      ['executors beyond inline and client', list(Object.keys(app.config.executors))],
      ['max concurrency', code(app.config.maxConcurrency)],
      [
        'type oracle',
        code(app.config.types ? 'on — escape elision is available' : 'off — everything is escaped'),
      ],
    ],
  )

  const counts = table(
    ['routes', 'compiled fragments', 'sealed templates', 'intents', 'assets'],
    [
      [
        code(app.routes.length),
        code(fragmentCount),
        code(app.compiled.templates.length),
        code(app.intents.entries.length),
        code(app.assets.files.size),
      ],
    ],
  )

  const diagnostics = app.diagnostics.length
    ? section(
        `${app.diagnostics.length} type diagnostics`,
        pre(app.diagnostics.join('\n')),
        'Escape elision fell back to escaping for these. The page is correct and pays for an escape it might not have needed.',
      )
    : section('diagnostics', '<p class="none">none — every hole the compiler could prove safe was elided</p>')

  return {
    current: '',
    title: basename(app.config.root) || 'application',
    subtitle: `weft ${app.mode} · devtools reads the App object this process is already holding, and compiles nothing`,
    root,
    body: [section('this application', configured), section('what is in memory', counts), diagnostics].join(
      '',
    ),
  }
}

function routeSection(route: RouteReport, root: string): string {
  const slots = table(
    [
      'slot',
      'fragment',
      'delivery',
      'executor',
      'class',
      'reads',
      'declared cache',
      'needs',
      'budget',
      'refresh',
      'form',
      'incremental',
    ],
    route.slots.map((slot) => [
      code(slot.spec.name),
      slot.file ? code(slot.file) : maybe(slot.spec.fragment),
      deliveryOf(slot.spec),
      code(slot.spec.executor),
      slot.facts ? code(cacheClassOf(slot.facts.effects)) : '<span class="none">—</span>',
      slot.facts ? list(slot.facts.effects.reads) : '<span class="none">—</span>',
      cacheOf(slot.spec.cache),
      list(slot.spec.needs),
      budgetOf(slot.spec.budget),
      refreshOf(slot.spec.refresh),
      formOf(slot.spec.form),
      code(slot.spec.incremental ? 'yes' : 'no'),
    ]),
  )

  const live = table(
    ['live region', 'key', 'invalidated by'],
    route.live.map((region) => [code(region.slot), code(region.key), list(region.tags)]),
  )

  const document_ = table(
    ['shell', 'guards', 'document policy', 'max concurrency', 'stylesheet', 'sealed markup'],
    [
      [
        maybe(route.plan.shell),
        list(route.plan.guards.map((guard) => guard.name)),
        cacheOf(route.plan.cache),
        code(route.plan.maxConcurrency),
        `${code(route.stylesheet)} ${route.stylesheetBytes === null ? '' : `<span class="unit">${bytes(route.stylesheetBytes)}</span>`}`,
        `<span class="unit">${bytes(route.markupBytes)}</span>`,
      ],
    ],
  )

  return (
    `<h3>${escape(route.pattern)}<a href="${escape(`${root}/why?route=${encodeURIComponent(route.pattern)}`)}">why</a></h3>` +
    document_ +
    slots +
    (route.live.length ? live : '') +
    `<details><summary>${route.css.length} stylesheets linked, in cascade order</summary>${list(route.css)}</details>`
  )
}

export function routes(app: App, root: string): Shell {
  const report = routeReport(app)
  return {
    current: 'routes',
    title: 'routes',
    subtitle: `${report.length} routes, as the file tree produced them and the generator planned them`,
    root,
    body: [
      section(
        'which routes can swap regions with which',
        shells(app),
        'A navigation arrives as regions only between routes that render into the same document — a different shell has different holes. This is the answer a <code>PLAN</code> frame carries to a client so a click on a link out of this group does not spend a round trip and a server render to discover it. See <code>spec/kernel/routing.md</code>.',
      ),
      section(
        'the route table',
        report.map((route) => routeSection(route, root)).join(''),
        'The plan is generated per route, so nothing here had to agree across pages. Cache class and reads are the compiler’s; delivery, executor, budget and refresh are the route’s own declaration.',
      ),
    ].join(''),
  }
}

/**
 * The shells, and which routes share one.
 *
 * Grouped rather than listed per route because the fact is about the *pair*: what matters is which
 * routes can hand each other regions, and a column saying `sh-4f2a` on every row leaves the reader
 * to do the grouping the framework already did.
 */
function shells(app: App): string {
  const byShell = new Map<string, { id: string; patterns: string[]; holes: string[] }>()
  for (const route of app.routes) {
    const held = byShell.get(route.shell.version) ?? {
      id: route.shell.id,
      patterns: [],
      holes: route.holes,
    }
    held.patterns.push(route.pattern)
    byShell.set(route.shell.version, held)
  }
  return table(
    ['document', 'version', 'holes', 'routes that render into it'],
    [...byShell.entries()].map(([version, group]) => [
      code(group.id),
      code(version),
      list(group.holes),
      list(group.patterns),
    ]),
  )
}

function keyRows(page: WhyPage): string {
  return table(
    ['slot', 'key', 'class', 'components', 'flag axes', 'Vary', 'why'],
    Object.entries(page.resolved).map(([slot, resolved]) => [
      code(slot),
      resolved.key ? code(resolved.key) : '<span class="none">uncacheable</span>',
      code(resolved.class),
      list(Object.entries(resolved.components).map(([read, value]) => `${read}=${value || '∅'}`)),
      list(Object.entries(resolved.axes).map(([axis, value]) => `${axis}=${value}`)),
      list(resolved.vary),
      escape(resolved.reason),
    ]),
  )
}

function paramForm(page: WhyPage, app: App, root: string): string {
  const options = app.routes
    .map(
      (route) =>
        `<option value="${escape(route.pattern)}"${route.pattern === page.pattern ? ' selected' : ''}>${escape(route.pattern)}</option>`,
    )
    .join('')
  const inputs = page.wants
    .map(
      (name) =>
        `<label>${escape(name)} <input name="${escape(name)}" value="${escape(page.params[name] ?? '')}" placeholder="${escape(name)}"></label>`,
    )
    .join('')
  return `<form class="params" method="get" action="${escape(`${root}/why`)}"><select name="route">${options}</select>${inputs}<button type="submit">ask</button></form>`
}

export async function why(
  app: App,
  root: string,
  query: URLSearchParams,
  headers: Headers,
  ports: Ports,
): Promise<Shell> {
  const pattern = query.get('route')
  if (!pattern) {
    return {
      current: 'why',
      title: 'why',
      subtitle: 'pick a route and this answers what its plan does and why each key is what it is',
      root,
      body: section(
        'routes',
        table(
          ['route', 'slots'],
          app.routes.map((route) => [
            `<a href="${escape(`${root}/why?route=${encodeURIComponent(route.pattern)}`)}">${escape(route.pattern)}</a>`,
            code(route.plan.slots.length),
          ]),
        ),
      ),
    }
  }

  const page = await whyPage(app, pattern, query, headers, ports)
  const keys = page.missing.length
    ? refusal(
        'E_ROUTE_PARAMS_MISSING',
        `${page.pattern} takes ${page.missing.join(', ')}, and a key cannot be resolved without them. ` +
          `Add them to this URL — ${root}/why?route=${page.pattern}&${page.missing.map((name) => `${name}=…`).join('&')} — and every key below is the one this request would really get.`,
      )
    : keyRows(page)

  const failures = page.refused
    .map((entry) => refusal('E_KEY_UNRESOLVED', `${entry.slot}: ${entry.message}`))
    .join('')

  return {
    current: 'why',
    title: `why ${page.pattern}`,
    subtitle: page.missing.length
      ? 'the plan, the waves and the critical path — keys are refused until the route’s params are given'
      : `keys resolved against ${page.at} and against this browser’s own cookies`,
    root,
    body: [
      paramForm(page, app, root),
      section(
        'the plan',
        pre(page.report.text),
        page.report.measured
          ? 'Timings are measured.'
          : 'Timings are unmeasured, and are printed as such: <code>weft why</code> refuses to invent them. The waves, the critical path and the diagnostics are structural and do not need a clock.',
      ),
      section(
        'keys',
        keys + failures,
        'One line per slot, from <code>resolveKey</code> — the same call the kernel makes before it renders anything, so this is the key, not a description of one.',
      ),
      section(
        'as data',
        `<details><summary>the generated plan, which is what <code>weft why ${escape(page.pattern)}</code> prints and what <code>${escape(app.config.outDir)}/routes.json</code> holds</summary>${pre(JSON.stringify(page.plan, null, 2))}</details>`,
      ),
    ].join(''),
  }
}

function holeRows(holes: readonly Hole[]): string {
  return table(
    ['#', 'kind', 'binding', 'escape', 'attribute', 'through', 'isolated', 'provenance'],
    holes.map((hole) => [
      code(hole.index),
      code(hole.kind),
      code(hole.binding),
      code(hole.escape),
      maybe(hole.attr),
      maybe(hole.nested?.slice(0, 12)),
      code(hole.isolated ? 'yes' : 'no'),
      maybe(hole.provenance),
    ]),
  )
}

export function fragments(app: App, root: string): Shell {
  const report = fragmentReport(app)
  const rows = table(
    ['name', 'file', 'class', 'reads', 'wire forms', 'sealed version', 'templates', 'holes', 'markup'],
    report.map((fragment) => [
      code(fragment.name),
      code(fragment.file),
      code(fragment.class),
      list(fragment.reads),
      list(fragment.forms),
      code(fragment.version.slice(0, 12)),
      code(fragment.templates.length),
      code(fragment.holes.length),
      `<span class="unit">${bytes(fragment.bytes)}</span>`,
    ]),
  )
  const details = report
    .map(
      (fragment) =>
        `<details><summary>${escape(fragment.name)} — ${escape(fragment.explanation)}</summary>${holeRows(fragment.holes)}</details>`,
    )
    .join('')
  return {
    current: 'fragments',
    title: 'fragments',
    subtitle: `${report.length} compiled fragments, each one sealed at a version that is a hash of its own markup`,
    root,
    body: [
      section(
        'every fragment the compiler produced',
        rows,
        'Reads are inferred, never declared: the set below is what the key is a hash of, and a read the compiler could not name statically would have failed the build rather than appeared here.',
      ),
      section('holes, per fragment', details),
    ].join(''),
  }
}

export function intents(app: App, root: string): Shell {
  const { authority } = app
  const rows = table(
    ['id', 'name', 'module', 'export', 'writes', 'capabilities', 'signed'],
    app.intents.entries.map((entry) => [
      code(entry.id),
      code(entry.name),
      code(entry.module),
      code(entry.export),
      list(entry.writes),
      entry.capabilities.length ? list(entry.capabilities) : '<span class="none">none</span>',
      entry.signed ? code('yes') : '<span class="none">no</span>',
    ]),
  )

  /**
   * What is actually enforcing the two declarations above.
   *
   * Both columns are worth nothing on their own: a capability with no model behind it is a 501 per
   * call, and a signature with no public key is the same. So this section answers the only question
   * a reader of that table has — whether this process can act on what it just showed them.
   */
  const bound = table(
    ['what', 'bound', 'note'],
    [
      [
        code('capability model'),
        authority.model ? code('yes') : '<span class="none">no</span>',
        authority.model
          ? 'wired into both bindings from one place, so a grant cannot be enforced over the channel and not over the POST path'
          : 'every intent declaring a capability answers E_NO_CAPABILITY_CHECK, which is a 501',
      ],
      [
        code('signer'),
        authority.signer ? code(`kid ${escape(authority.signer.kid)}`) : '<span class="none">no</span>',
        authority.signer
          ? `POST /_weft/token mints for a signed intent, ${authority.signer.ttlMs / 1000}s lifetime`
          : 'this process can check tokens and mint none, which is a complete verifying deployment',
      ],
      [
        code('verifier'),
        authority.verifier ? list(authority.verifier.kids) : '<span class="none">no</span>',
        authority.verifier
          ? `replay is remembered ${authority.verifier.replayScope}-wide, in ${escape(app.store.name)}`
          : 'every signed intent answers E_NO_VERIFIER',
      ],
      [
        code('declared set'),
        authority.declared.length ? list(authority.declared) : '<span class="none">none</span>',
        'every capability any intent requires. A grant naming something outside it is a stale row; a requirement nothing grants fails the build',
      ],
    ],
  )
  const warnings = authority.diagnostics.length
    ? table(
        ['warning'],
        authority.diagnostics.map((line) => [escape(line)]),
      )
    : '<p class="none">nothing bound here will refuse what it claims to allow.</p>'
  const routes_ = table(
    ['method', 'path', 'dispatches'],
    app.intents.routes.map((route) => [code(route.method), code(route.pattern), code(route.intent)]),
  )
  return {
    current: 'intents',
    title: 'intents',
    subtitle: `${app.intents.entries.length} intents, id derived from module and export and from nothing else`,
    root,
    body: [
      section(
        'the manifest',
        rows,
        'The id is the same hash the compiler wrote into a template’s wiring. A manifest that spelled its own would be a manifest that could disagree with the markup, and that disagreement looks exactly like an intent that silently does nothing.',
      ),
      section(
        'reachable without JavaScript',
        routes_,
        'Each intent is dispatchable by id and by the name its author gave it, so a plain <code>&lt;form action&gt;</code> can reach one. An intent that is <code>signed</code> is the exception and refuses that path by name: a token cannot be rendered into a page, because a page can be cached and a token cannot.',
      ),
      section(
        'authority',
        bound,
        'A declaration nothing enforces is worse than no declaration, so both halves are shown together. See <code>spec/kernel/authority.md</code>.',
      ),
      section(
        'what will not do what it says',
        warnings,
        'The same lines <code>weft dev</code> prints on startup. Each one is also a named refusal per call; this is where it is legible before the first call.',
      ),
    ].join(''),
  }
}

export async function bytesPage(app: App, root: string): Promise<Shell> {
  const report = await byteReport(app)
  const assets = table(
    ['href', 'bytes', 'type', 'cache-control'],
    report.assets.map((asset) => [
      code(asset.href),
      `<span class="unit">${bytes(asset.bytes)}</span>`,
      code(asset.type),
      code(asset.immutable ? 'immutable, one year' : 'no-store'),
    ]),
  )
  const trees = table(
    ['mounted at', 'from', 'files', 'served as'],
    report.trees.map((tree) => [
      code(tree.prefix),
      code(tree.dir),
      code(tree.files),
      code(tree.ext === '.ts' ? 'TypeScript, types stripped per request' : 'JavaScript'),
    ]),
  )
  const perRoute = table(
    ['route', 'sealed markup', 'stylesheet', 'stylesheet bytes'],
    report.routes.map((route) => [
      code(route.pattern),
      `<span class="unit">${bytes(route.markupBytes)}</span>`,
      code(route.stylesheet),
      route.stylesheetBytes === null
        ? '<span class="none">not in the asset table</span>'
        : `<span class="unit">${bytes(route.stylesheetBytes)}</span>`,
    ]),
  )
  return {
    current: 'bytes',
    title: 'bytes',
    subtitle: report.revved
      ? 'every URL carries a digest of its contents, so every one of them is immutable'
      : 'dev serves stable names with no-store — a stylesheet you just edited, served as immutable, is a framework that lies to you for a year',
    root,
    body: [
      section(
        `assets — ${report.assets.length} files, ${report.totalBytes.toLocaleString('en-US')} B measured`,
        assets,
        'Measured, not estimated: this is the byte length of the body in the table this server serves from.',
      ),
      section(
        'module trees',
        trees,
        'These are not in the table above and have no byte count here. A module is read from source and transformed on the way out, so the file on disk is not what the browser receives — and a number nobody measured is not a number worth printing.',
      ),
      section(
        'per page',
        perRoute,
        `Sealed markup is every template the page’s slots need, counted once per version — the same number <code>weft build</code> reports. The client runtime is the boot module at ${code(report.boot)}${report.app ? ` and the application’s own ${code(report.app)}` : ''}.`,
      ),
    ].join(''),
  }
}
