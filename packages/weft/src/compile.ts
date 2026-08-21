import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
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
}

export interface CompiledApp {
  /** By logical name: `layout`, `markup`, `route:/blog/:slug`, `slot:header`, `fragment:card`. */
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
  for (const name of ['layout.tsx', 'markup.tsx']) {
    const to = join(target, name)
    await copyFile(join(ASSETS, name), to)
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
    ...discovered.slots.map((slot) => ({ name: `slot:${slot.name}`, file: slot.file })),
    ...discovered.fragments.map((f) => ({ name: `fragment:${f.name}`, file: f.file })),
  ]

  // Deduplicated, because one file may be both the layout and a named fragment, and the
  // compiler must see each file once or a template would be sealed twice under one id.
  const files = [...new Set(named.map((n) => n.file))]
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

/** Slot boundaries a layout leaves, in document order. The plan has to fill exactly these. */
export function slotHoles(layout: CompiledFragment): string[] {
  return layout.entry.holes.filter((h) => h.kind === 'slot').map((h) => h.binding)
}

export function listHole(fragment: CompiledFragment): string | undefined {
  return fragment.entry.holes.find((h) => h.kind === 'list')?.binding
}

export { dirname }
