import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { compileFiles } from '@weftjs/compiler'
import type { Resolver, TemplateIR } from '@weftjs/ir'
import type { Discovered } from './convention.ts'
import { scopeAttribute, scopeStem } from './scoped.ts'

/**
 * The application's own fragments, compiled by the real compiler, once. Nothing downstream holds a
 * hand-written IR — a cache class, a read set or a hole is the one the compiler inferred.
 */
export interface CompiledFragment {
  entry: TemplateIR
  templates: TemplateIR[]
  resolve: Resolver
  /** Project-relative, for a diagnostic that has to name a file. */
  file: string
  /**
   * The bytes on disk that produced this IR. Carried rather than left for the caller to read: a
   * caller reading the path itself could read a file that has since changed.
   */
  source: string
}

/** Every sealed template this application has, by the name the convention gave it. */
export interface CompiledApp {
  /**
   * By logical name: `layout`, `error`, `markup`, `route:/blog/:slug`, `slot:header`,
   * `fragment:card`, and `nested:/dashboard` for a layout scoped to a subtree of the route table.
   */
  fragments: Record<string, CompiledFragment>
  diagnostics: string[]
  /** Every sealed template, for a build artifact and for the channel's template lookup. */
  templates: TemplateIR[]
}

const ASSETS = fileURLToPath(new URL('./assets/', import.meta.url))

/**
 * The framework's own `.tsx` files are copied into the project's out directory before they are
 * compiled: a template id is stated relative to the compile root, so compiling them where they
 * are installed would make a version depend on how deep `node_modules` happens to be.
 */
export const STAGED_DIR = 'staged'

/**
 * Stage them, and answer with where each one went. Beside `assets/` rather than inside it: that
 * directory is published, and these are working copies of framework source — a scratch directory
 * that is also the deployment shipped `.tsx` files and a `tsconfig.json` at the site root once.
 */
export async function stageAssets(root: string, outDir: string): Promise<Record<string, string>> {
  const target = join(root, outDir, STAGED_DIR)
  await mkdir(target, { recursive: true })
  const staged: Record<string, string> = {}
  // Copied through a temporary name: `copyFile` truncates then writes, so a second process
  // compiling concurrently could read the file mid-write and get `E_NO_FRAGMENT`. A rename within
  // a directory is atomic; the temp name carries the process id so two writers cannot collide.
  for (const name of ['layout.tsx', 'markup.tsx', 'error.tsx']) {
    const to = join(target, name)
    const staging = `${to}.${process.pid.toString(36)}.tmp`
    await copyFile(join(ASSETS, name), staging)
    await rename(staging, to)
    staged[name.replace(/\.tsx$/, '')] = to
  }
  // A tsconfig of their own: a file the application's tsconfig does not include gets default
  // options, under which every tag here is a missing-react error.
  await writeFile(
    join(target, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'es2023',
          lib: ['es2023', 'dom'],
          jsx: 'preserve',
          module: 'nodenext',
          moduleResolution: 'nodenext',
          allowImportingTsExtensions: true,
          verbatimModuleSyntax: true,
          noEmit: true,
          strict: true,
          skipLibCheck: true,
        },
        include: ['*.tsx'],
      },
      null,
      2,
    )}\n`,
  )
  return staged
}

/** The framework's own stylesheet, which an application's is appended after. */
export async function frameworkStyles(): Promise<string> {
  return readFile(join(ASSETS, 'styles.css'), 'utf8')
}

function pick(
  fragments: { entry: TemplateIR; templates: TemplateIR[]; exportName: string }[],
  file: string,
): { entry: TemplateIR; templates: TemplateIR[] } {
  const chosen = fragments.find((f) => f.exportName === 'default') ?? fragments[0]
  if (!chosen) {
    throw new Error(
      `E_NO_FRAGMENT: ${file} exports no fragment(). A page, a layout and a slot are each ` +
        `a default-exported fragment(); a file that exports none renders nothing`,
    )
  }
  return chosen
}

/** Every `.scoped.css` the convention found, wherever in the tree. One place that knows all six kinds of sheet. */
export function scopedSheets(discovered: Discovered): string[] {
  return [
    discovered.layoutScopedCss,
    ...discovered.nested.map((n) => n.scopedCss),
    ...discovered.routes.map((r) => r.scopedCss),
    ...discovered.layouts.map((l) => l.scopedCss),
    ...discovered.slots.map((s) => s.scopedCss),
    ...discovered.fragments.map((f) => f.scopedCss),
  ].filter((file): file is string => Boolean(file))
}

/** Compile everything the convention found, in dependency order, with the framework's own files staged. */
export async function compileApp(
  discovered: Discovered,
  options: { outDir: string; types?: boolean },
): Promise<CompiledApp> {
  const { root } = discovered
  const staged = await stageAssets(root, options.outDir)

  const named: { name: string; file: string }[] = [
    { name: 'markup', file: staged.markup as string },
    { name: 'layout', file: discovered.layout ?? (staged.layout as string) },
    // The framework's own, always compiled. `app/layouts/error.tsx` takes precedence at render
    // time — see `errorDocument` in serve.ts.
    { name: 'error', file: staged.error as string },
    ...discovered.routes
      .filter((route) => route.file)
      .map((route) => ({ name: `route:${route.pattern}`, file: route.file as string })),
    ...discovered.layouts.map((l) => ({ name: `layout:${l.name}`, file: l.file })),
    ...discovered.nested.map((n) => ({ name: `nested:${n.scope}`, file: n.file })),
    ...discovered.slots.map((slot) => ({ name: `slot:${slot.name}`, file: slot.file })),
    ...discovered.fragments.map((f) => ({ name: `fragment:${f.name}`, file: f.file })),
  ]

  // Deduplicated, because one file may be both the layout and a named fragment, and the
  // compiler must see each file once or a template would be sealed twice under one id.
  const files = [...new Set(named.map((n) => n.file))]
  // Read once, before the compiler is asked for anything, so what a station displays and what the
  // compiler saw are the same bytes even if the file changes mid-build.
  const sources = new Map<string, string>()
  for (const file of files) sources.set(file, await readFile(file, 'utf8'))
  // Which files bring a scoped stylesheet, and what attribute their elements carry. The id comes
  // from the shared stem, so the sheet derives the same one when rewritten.
  const scoped = new Map<string, string>()
  for (const file of scopedSheets(discovered)) {
    scoped.set(`${scopeStem(file)}.tsx`, scopeAttribute(relative(root, scopeStem(file))))
  }

  const { modules, diagnostics } = await compileFiles(files, {
    root,
    ...(options.types === false ? { types: false } : {}),
    ...(scoped.size ? { cssScopes: (file: string) => scoped.get(file) } : {}),
  })

  const byFile = new Map(modules.map((m) => [m.file, m]))
  const fragments: Record<string, CompiledFragment> = {}
  const templates: TemplateIR[] = []

  for (const { name, file } of named) {
    const compiledModule = byFile.get(file) ?? [...byFile.values()].find((m) => m.file.endsWith(file))
    if (!compiledModule) throw new Error(`E_NOT_COMPILED: ${relative(root, file)}`)
    const chosen = pick(compiledModule.fragments, relative(root, file))
    const byVersion = new Map(chosen.templates.map((t) => [t.version, t]))
    fragments[name] = {
      entry: chosen.entry,
      templates: chosen.templates,
      resolve: (version) => byVersion.get(version),
      file: relative(root, file),
      source: sources.get(file) ?? '',
    }
    templates.push(...chosen.templates)
  }

  return { fragments, diagnostics, templates: [...new Map(templates.map((t) => [t.version, t])).values()] }
}

/**
 * Which named fragments a fragment renders, read from the templates it was sealed with — a page
 * composing `<Card/>` needs `card.css`, and matching template versions answers that without a
 * second dependency graph.
 */
export function composedIn(app: CompiledApp, fragment: CompiledFragment): CompiledFragment[] {
  const versions = new Set(fragment.templates.map((t) => t.version))
  return Object.values(app.fragments).filter(
    (other) => other !== fragment && versions.has(other.entry.version),
  )
}

/** Slot boundaries a fragment leaves for somebody else to fill, in document order. */
export function slotHoles(fragment: CompiledFragment): string[] {
  return fragment.entry.holes.filter((h) => h.kind === 'slot').map((h) => h.binding)
}

/**
 * The binding name of a fragment's list hole, taken from the IR rather than written down, so a
 * rename in the `.tsx` cannot leave a loader filling a hole that no longer exists.
 */
export function listHole(fragment: CompiledFragment): string {
  const hole = fragment.entry.holes.find((h) => h.kind === 'list')
  if (!hole) throw new Error(`E_NO_LIST_HOLE: ${fragment.file} has no list hole`)
  return hole.binding
}
