import { readdir, access } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

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
 *   app/routes/index.tsx        /
 *   app/routes/about.tsx        /about
 *   app/routes/blog/[slug].tsx  /blog/:slug
 *   app/routes/docs/[...].tsx   /docs/*
 *   app/routes/x.data.ts        x.tsx's declaration: head, cache, load, guard, slots
 *   app/routes/x.css            x.tsx's own stylesheet, linked only by the pages that use it
 *   app/client.ts               the application's own client code, loaded after adoption
 *
 * A route is a `.tsx`, or a `.data.ts` that says what renders its body — a page whose content is
 * markup rather than a template needs no template file, and requiring an empty one would be
 * ceremony rather than convention.
 *   app/layouts/<name>.tsx      an alternate document, chosen with defineRoute({ layout })
 *   app/slots/<name>.tsx        fills the layout hole of that name on every route
 *   app/fragments/<name>.tsx    reusable, referenced by name from a route's slots
 *   app/intents/**.ts           intents. The manifest is generated from this directory
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
  /** How specific this route is, for a stable order in a generated table. */
  depth: number
}

export interface DiscoveredNamed {
  name: string
  file: string
  data?: string
  css?: string
}

export interface Discovered {
  root: string
  srcDir: string
  /** Absent when the application has no layout of its own and gets the framework's. */
  layout?: string
  layoutCss?: string
  routes: DiscoveredRoute[]
  /** Alternate documents. A route names one, or gets `layout.tsx`. */
  layouts: DiscoveredNamed[]
  slots: DiscoveredNamed[]
  fragments: DiscoveredNamed[]
  intents: string[]
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

  // One entry per route, keyed by the stem the files share, so a `.tsx` and a `.data.ts` of the
  // same name are one route and either of them alone is also one.
  const stems = new Map<string, { tsx?: string; data?: string; css?: string }>()
  for (const file of files) {
    const stem = file.replace(/\.data\.ts$|\.tsx$|\.css$/, '')
    const entry = stems.get(stem) ?? {}
    if (file.endsWith('.data.ts')) entry.data = file
    else if (file.endsWith('.tsx')) entry.tsx = file
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
      out.push({
        name,
        file,
        ...((await exists(data)) ? { data } : {}),
        ...((await exists(css)) ? { css } : {}),
      })
    }
    return out
  }

  const layout = join(base, 'layout.tsx')
  const layoutCss = join(base, 'layout.css')
  const styles = join(base, 'styles.css')
  const client = join(base, 'client.ts')

  return {
    root,
    srcDir,
    ...((await exists(layout)) ? { layout } : {}),
    ...((await exists(layoutCss)) ? { layoutCss } : {}),
    routes: routes.sort((a, b) => b.depth - a.depth || a.pattern.localeCompare(b.pattern)),
    layouts: await named('layouts'),
    slots: await named('slots'),
    fragments: await named('fragments'),
    intents: (await walk(join(base, 'intents'))).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts')),
    ...((await exists(styles)) ? { styles } : {}),
    ...((await exists(client)) ? { client } : {}),
  }
}
