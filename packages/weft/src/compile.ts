import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { compileFiles } from '@weft/compiler'
import type { Resolver, TemplateIR } from '@weft/ir'
import type { Discovered } from './convention.ts'

/**
 * The application's own fragments, compiled by the real compiler, once.
 *
 * Nothing downstream of this holds a hand-written IR. A cache class, a read set, an escape
 * decision or a hole is the one the compiler inferred from the `.tsx` file the user can open —
 * which is the only arrangement worth having, because a framework whose generated plan is
 * validated against facts from somewhere else is a framework that will contradict itself.
 */
export interface CompiledFragment {
  entry: TemplateIR
  templates: TemplateIR[]
  resolve: Resolver
  /** Project-relative, for a diagnostic that has to name a file. */
  file: string
  /**
   * The bytes on disk that produced this IR.
   *
   * Carried rather than left for the caller to read, because a page that shows you a template's
   * holes beside its source has to be showing you the file that produced *those* holes — and a
   * caller reading the path itself could read a file that has since changed. Empty when the
   * source is not present, which is the case in a deployment that shipped only the build.
   */
  source: string
}

export interface CompiledApp {
  /**
   * By logical name: `layout`, `markup`, `route:/blog/:slug`, `slot:header`, `fragment:card`,
   * and `nested:/dashboard` for a layout scoped to a subtree of the route table.
   */
  fragments: Record<string, CompiledFragment>
  diagnostics: string[]
  /** Every sealed template, for a build artifact and for the channel's template lookup. */
  templates: TemplateIR[]
}

const ASSETS = fileURLToPath(new URL('./assets/', import.meta.url))

/**
 * The framework's own `.tsx` files are copied into the project's out directory before they are
 * compiled, and that is not tidiness. A template id is stated relative to the compile root and
 * feeds the content hash, so compiling them where they are installed would make a template's
 * version depend on how deep `node_modules` happens to be.
 */
export async function stageAssets(root: string, outDir: string): Promise<Record<string, string>> {
  const target = join(root, outDir, 'assets')
  await mkdir(target, { recursive: true })
  const staged: Record<string, string> = {}
  /**
   * Copied through a temporary name, and that is not caution for its own sake.
   *
   * `copyFile` truncates the destination and then writes it, so a second process compiling the same
   * project at the same moment can read the file between those two steps and get nothing — which
   * surfaces as `E_NO_FRAGMENT` on the framework's own markup fragment, a failure whose message
   * describes a file the user did not write and cannot fix. Two `weft dev` processes on one project,
   * a build beside a running server, and a test suite that starts several applications in parallel
   * are all ordinary; this was flaky for the last of those roughly one run in eight.
   *
   * A rename within a directory is atomic, so a concurrent reader sees either the whole previous file
   * or the whole new one. The temporary name carries the process id, so two writers cannot collide on
   * it either.
   */
  for (const name of ['layout.tsx', 'markup.tsx']) {
    const to = join(target, name)
    const staging = `${to}.${process.pid.toString(36)}.tmp`
    await copyFile(join(ASSETS, name), staging)
    await rename(staging, to)
    staged[name.replace(/\.tsx$/, '')] = to
  }
  // A tsconfig of their own. The type oracle asks the checker for the project a file belongs to,
  // and a file the application's tsconfig does not include gets default options — under which
  // `jsx: preserve` is not set and every tag in these two files is a missing-react error. The
  // diagnostic is harmless, and a framework that emits harmless errors teaches you to ignore them.
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

export async function compileApp(
  discovered: Discovered,
  options: { outDir: string; types?: boolean },
): Promise<CompiledApp> {
  const { root } = discovered
  const staged = await stageAssets(root, options.outDir)

  const named: { name: string; file: string }[] = [
    { name: 'markup', file: staged.markup as string },
    { name: 'layout', file: discovered.layout ?? (staged.layout as string) },
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
  const { modules, diagnostics } = await compileFiles(files, {
    root,
    ...(options.types === false ? { types: false } : {}),
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
 * Which named fragments a fragment renders, read from the templates it was sealed with.
 *
 * A page that composes `<Card/>` needs `card.css`, and nothing in the route's declaration says
 * so — the composition is in the page's own source. The compiler already resolved it: the page's
 * template set contains the child's sealed template, so matching versions answers the question
 * without a second dependency graph that could disagree with the first.
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
 * The binding name of a fragment's list hole, taken from the IR rather than written down.
 *
 * A loader has to name the key it puts its rows under, and that name is the compiler's — it came
 * from the parameter the template destructured. Asking the IR means a rename in the `.tsx` cannot
 * leave a loader filling a hole that no longer exists.
 */
export function listHole(fragment: CompiledFragment): string {
  const hole = fragment.entry.holes.find((h) => h.kind === 'list')
  if (!hole) throw new Error(`E_NO_LIST_HOLE: ${fragment.file} has no list hole`)
  return hole.binding
}
