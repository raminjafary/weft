import { readdir, access } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'

/**
 * The folder convention, read once.
 *
 * A convention is only worth having if it is the single source of the route table, so nothing
 * downstream of this file may add a route: `weft build` generates plans from what this found,
 * and a page that is not here does not exist. The rules are the ones Nuxt, Remix and SvelteKit
 * converged on, because a user arriving here should not have to learn a third vocabulary for
 * the same idea.
 *
 *   app/layout.tsx              the document. Its `<slot>` holes are what a route fills.
 *   app/routes/<dir>/layout.tsx a nested layout, wrapping every route at or under <dir>
 *   app/routes/index.tsx        /
 *   app/routes/about.tsx        /about
 *   app/routes/blog/[slug].tsx  /blog/:slug
 *   app/routes/docs/[...].tsx   /docs/*
 *   app/routes/x.data.ts        x.tsx's declaration: head, cache, load, guard, slots
 *   app/routes/x.css            x.tsx's own stylesheet, linked only by the pages that use it
 *   app/routes/x.scoped.css     the same, narrowed to the elements x.tsx declares. See `scoped.ts`
 *   app/client.ts               the application's own client code, loaded after adoption
 *
 * A route is a `.tsx`, or a `.data.ts` that says what renders its body — a page whose content is
 * markup rather than a template needs no template file, and requiring an empty one would be
 * ceremony rather than convention.
 *   app/layouts/<name>.tsx      an alternate document, chosen with defineRoute({ layout })
 *   app/slots/<name>.tsx        fills the layout hole of that name on every route
 *   app/fragments/<name>.tsx    reusable, referenced by name from a route's slots
 *   app/intents/**.ts           intents. The manifest is generated from this directory
 *   app/renderables/**.ts       fragments a client may ask for by opaque id. Same derivation
 *   app/styles.css              appended after the framework's stylesheet
 */
export interface DiscoveredRoute {
  /** `/blog/:slug`, derived from the file path and from nothing else. */
  pattern: string
  /** The `.tsx` that renders the body slot. Absent when the declaration says what does. */
  file?: string
  /** The sibling `.data.ts`, if the route has one. */
  data?: string
  /** The sibling `.css`, if the page brought its own. */
  css?: string
  /** The sibling `.scoped.css`, narrowed to the elements this page's template declares. */
  scopedCss?: string
  /** How specific this route is, for a stable order in a generated table. */
  depth: number
}

/** A named fragment, layout or slot, with the files that travel with it. */
export interface DiscoveredNamed {
  name: string
  file: string
  data?: string
  css?: string
  /** The sibling `.scoped.css`, narrowed to the elements this fragment declares. */
  scopedCss?: string
}

/**
 * A layout that wraps a subtree of the route table rather than the whole application.
 *
 * `app/routes/dashboard/layout.tsx` wraps every route at or under `/dashboard`, nested inside the
 * application's own document. Directory-scoped rather than declared, for the reason every other
 * placement in this file is: the file tree is the single source of the route table, and a chain
 * assembled from a declaration somewhere else would be a second source that could disagree with it.
 *
 * `layout` is therefore a reserved page name under `routes/`: a file called `layout.tsx` is a
 * wrapper, never a route. There is no `layout.data.ts` — a nested layout's holes are filled by the
 * route's own declaration, exactly as the root layout's are, and a declaration attached to the
 * wrapper would be one that every route under it silently shared.
 */
export interface DiscoveredNested {
  /** The route-pattern prefix this layout wraps: `/dashboard`, or `/` at the top of `routes/`. */
  scope: string
  file: string
  css?: string
  /** The sibling `layout.scoped.css`, narrowed to the elements this layout declares. */
  scopedCss?: string
  /** Segments in the scope, so a chain sorts outermost-first without re-parsing the pattern. */
  depth: number
}

/** The whole file tree as the framework reads it. Nothing downstream may add to this. */
export interface Discovered {
  root: string
  srcDir: string
  /** Absent when the application has no layout of its own and gets the framework's. */
  layout?: string
  layoutCss?: string
  /** `app/layout.scoped.css`: the document's own rules, narrowed to the elements it declares. */
  layoutScopedCss?: string
  routes: DiscoveredRoute[]
  /** Alternate documents. A route names one, or gets `layout.tsx`. */
  layouts: DiscoveredNamed[]
  /** Layouts scoped to a subtree of `routes/`, outermost first. */
  nested: DiscoveredNested[]
  slots: DiscoveredNamed[]
  fragments: DiscoveredNamed[]
  intents: string[]
  /**
   * The catalogue: modules exporting fragments a client may ask to have rendered.
   *
   * A separate directory from `intents/` because they are separate questions with the same shape —
   * one writes and one renders — and because what is in this directory is *reachable by a client*.
   * A fragment under `fragments/` is a thing a page composes; one named here is a thing a browser can
   * ask for, and the difference should be visible in the file tree rather than in a declaration
   * somewhere.
   */
  renderables: string[]
  styles?: string
  /** `app/client.ts`, served after the framework's own boot has adopted the page. */
  client?: string
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function walk(dir: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(path)))
    else out.push(path)
  }
  return out
}

/** A file-tree refusal: a duplicate route, a wildcard that is not last, an orphan stylesheet. */
export class ConventionError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(`${code} — ${message}`)
    this.name = 'ConventionError'
    this.code = code
  }
}

/**
 * A file path becomes a route pattern. `index` is the directory itself, `[name]` is a param,
 * and `[...]` or `[...rest]` is the wildcard — which the router requires to be last, so a
 * file that puts it anywhere else is a build error here rather than a router error later.
 */
export function patternOf(relativePath: string): string {
  const parts = relativePath
    .split(sep)
    .join('/')
    .replace(/\.tsx$/, '')
    .split('/')
  if (parts.at(-1) === 'index') parts.pop()
  const segments = parts.map((part, index) => {
    const wildcard = /^\[\.\.\.[a-zA-Z0-9_-]*\]$/.exec(part)
    if (wildcard) {
      if (index !== parts.length - 1) {
        throw new ConventionError(
          'E_WILDCARD_NOT_LAST',
          `${relativePath}: a [...] segment has to be the last one, because a wildcard cannot be followed by anything`,
        )
      }
      return '*'
    }
    const param = /^\[([a-zA-Z][a-zA-Z0-9_-]*)\]$/.exec(part)
    if (param) return `:${param[1]}`
    if (part.includes('[') || part.includes(']')) {
      throw new ConventionError(
        'E_BAD_SEGMENT',
        `${relativePath}: '${part}' is neither a literal, a [param] nor a [...wildcard]`,
      )
    }
    return part
  })
  return `/${segments.join('/')}`.replace(/\/+$/, '') || '/'
}

/**
 * The nested layouts that wrap a route, outermost first.
 *
 * Matched segment by segment rather than by string prefix, because `/blog` is not a prefix of
 * `/blogroll` in any sense a router would recognise — and a layout that wrapped the wrong subtree
 * would do it silently, on a page that renders.
 */
export function chainFor(pattern: string, nested: readonly DiscoveredNested[]): DiscoveredNested[] {
  const segments = pattern.split('/').filter(Boolean)
  return nested
    .filter((entry) => {
      if (entry.scope === '/') return true
      const scope = entry.scope.split('/').filter(Boolean)
      if (scope.length > segments.length) return false
      return scope.every((part, index) => part === segments[index])
    })
    .sort((a, b) => a.depth - b.depth || a.scope.localeCompare(b.scope))
}

/** Read the convention once. The single source of the route table, and the only one. */
export async function discover(root: string, srcDir = 'app'): Promise<Discovered> {
  const base = join(root, srcDir)
  if (!(await exists(base))) {
    throw new ConventionError(
      'E_NO_APP_DIR',
      `${srcDir}/ does not exist. A weft application is a folder: ${srcDir}/routes/index.tsx is the smallest one there is`,
    )
  }

  const routesDir = join(base, 'routes')
  const files = await walk(routesDir)
  const routes: DiscoveredRoute[] = []
  const byPattern = new Map<string, string>()

  // `layout.tsx` under `routes/` is a wrapper, not a page, so it is taken out before anything else
  // sees the file list. Left in, it would be a route called `/dashboard/layout` — which is not what
  // anybody who wrote the file meant, and is the sort of thing a convention has to decide once.
  const nested: DiscoveredNested[] = []
  const pages: string[] = []
  for (const file of files) {
    const stem = file.replace(/\.data\.ts$|\.tsx$|\.scoped\.css$|\.css$/, '')
    if (stem.endsWith(`${sep}layout`)) {
      if (file.endsWith('.data.ts')) {
        throw new ConventionError(
          'E_NESTED_LAYOUT_DATA',
          `${relative(root, file)}: a nested layout has no declaration. Its holes are filled by each ` +
            `route's own defineRoute({ slots }), because a declaration here would be one every route ` +
            `under it shared without saying so`,
        )
      }
      if (!file.endsWith('.tsx') && !file.endsWith('.css')) continue
      const dir = relative(routesDir, stem.slice(0, -`${sep}layout`.length))
      const scope = patternOf(dir ? `${dir}${sep}index.tsx` : 'index.tsx')
      const found = nested.find((entry) => entry.scope === scope)
      const held = found ?? { scope, file: '', depth: scope === '/' ? 0 : scope.split('/').length - 1 }
      if (file.endsWith('.tsx')) held.file = file
      else if (file.endsWith('.scoped.css')) held.scopedCss = file
      else held.css = file
      if (!found) nested.push(held)
      continue
    }
    pages.push(file)
  }
  for (const entry of nested) {
    if (entry.file) continue
    throw new ConventionError(
      'E_ORPHAN_CSS',
      `${relative(root, entry.css as string)} has no layout.tsx beside it, so nothing links it`,
    )
  }

  // One entry per route, keyed by the stem the files share, so a `.tsx` and a `.data.ts` of the
  // same name are one route and either of them alone is also one.
  const stems = new Map<string, { tsx?: string; data?: string; css?: string; scoped?: string }>()
  for (const file of pages) {
    const stem = file.replace(/\.data\.ts$|\.tsx$|\.scoped\.css$|\.css$/, '')
    const entry = stems.get(stem) ?? {}
    if (file.endsWith('.data.ts')) entry.data = file
    else if (file.endsWith('.tsx')) entry.tsx = file
    else if (file.endsWith('.scoped.css')) entry.scoped = file
    else if (file.endsWith('.css')) entry.css = file
    else continue
    stems.set(stem, entry)
  }

  for (const [stem, entry] of [...stems].sort(([a], [b]) => a.localeCompare(b))) {
    if (!entry.tsx && !entry.data) {
      throw new ConventionError(
        'E_ORPHAN_CSS',
        `${relative(root, stem)}.css has neither a page nor a declaration beside it, so nothing links it`,
      )
    }
    if (entry.scoped && !entry.tsx) {
      throw new ConventionError(
        'E_SCOPED_NO_TEMPLATE',
        `${relative(root, entry.scoped)} has no ${basename(stem)}.tsx beside it. A scoped sheet is ` +
          `narrowed to the elements a template declares, and a route whose body is markup from a ` +
          `declaration has none to narrow it to — name the file ${basename(stem)}.css to make it global`,
      )
    }
    const rel = relative(routesDir, `${stem}.tsx`)
    const pattern = patternOf(rel)
    const clash = byPattern.get(pattern)
    if (clash) {
      throw new ConventionError(
        'E_DUPLICATE_ROUTE',
        `${rel} and ${relative(routesDir, clash)} both mean ${pattern}. Two files cannot be one route`,
      )
    }
    byPattern.set(pattern, `${stem}.tsx`)
    routes.push({
      pattern,
      depth: pattern.split('/').length,
      ...(entry.tsx ? { file: entry.tsx } : {}),
      ...(entry.data ? { data: entry.data } : {}),
      ...(entry.css ? { css: entry.css } : {}),
      ...(entry.scoped ? { scopedCss: entry.scoped } : {}),
    })
  }

  const named = async (dir: string): Promise<DiscoveredNamed[]> => {
    const out: DiscoveredNamed[] = []
    for (const file of await walk(join(base, dir))) {
      if (!file.endsWith('.tsx')) continue
      const name = relative(join(base, dir), file)
        .split(sep)
        .join('/')
        .replace(/\.tsx$/, '')
      const data = file.replace(/\.tsx$/, '.data.ts')
      const css = file.replace(/\.tsx$/, '.css')
      const scoped = file.replace(/\.tsx$/, '.scoped.css')
      out.push({
        name,
        file,
        ...((await exists(data)) ? { data } : {}),
        ...((await exists(css)) ? { css } : {}),
        ...((await exists(scoped)) ? { scopedCss: scoped } : {}),
      })
    }
    return out
  }

  const layout = join(base, 'layout.tsx')
  const layoutCss = join(base, 'layout.css')
  const layoutScopedCss = join(base, 'layout.scoped.css')
  const styles = join(base, 'styles.css')
  const client = join(base, 'client.ts')

  return {
    root,
    srcDir,
    ...((await exists(layout)) ? { layout } : {}),
    ...((await exists(layoutCss)) ? { layoutCss } : {}),
    ...((await exists(layoutScopedCss)) ? { layoutScopedCss } : {}),
    routes: routes.sort((a, b) => b.depth - a.depth || a.pattern.localeCompare(b.pattern)),
    layouts: await named('layouts'),
    nested: nested.sort((a, b) => a.depth - b.depth || a.scope.localeCompare(b.scope)),
    slots: await named('slots'),
    fragments: await named('fragments'),
    intents: (await walk(join(base, 'intents'))).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts')),
    renderables: (await walk(join(base, 'renderables'))).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.d.ts'),
    ),
    ...((await exists(styles)) ? { styles } : {}),
    ...((await exists(client)) ? { client } : {}),
  }
}
