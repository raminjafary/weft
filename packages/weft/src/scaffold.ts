import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `weft create`, and what `npm create weft` runs.
 *
 * The scaffold's job is not to save typing. It is to make the convention legible: every file it
 * writes is one the framework will actually read, each one says what it is for, and the page it
 * produces is a real page — it renders through the kernel, its CSS is linked the way a
 * component's CSS is linked, and its buttons dispatch a real intent. A scaffold whose output is a
 * placeholder teaches nothing about the framework it is scaffolding.
 */
export type Template = 'app' | 'minimal'

/** Where to write a new application, what to call it, and which template to use. */
export interface ScaffoldOptions {
  directory: string
  name?: string
  template?: Template
}

/** What was written, and the message `npm create weft` prints. */
export interface Scaffolded {
  directory: string
  files: string[]
  message: string
}

const TEMPLATES = fileURLToPath(new URL('../templates/', import.meta.url))

/** Files whose names cannot be committed as they are, because the tool would act on them. */
const RENAME: Record<string, string> = { _gitignore: '.gitignore' }

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(path)))
    else out.push(path)
  }
  return out
}

async function version(): Promise<string> {
  try {
    const manifest = JSON.parse(
      await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { version?: string }
    return manifest.version ? `^${manifest.version}` : 'latest'
  } catch {
    return 'latest'
  }
}

const NAME = /^[a-z0-9][a-z0-9._-]*$/

/** Write a new application. No step here is one you cannot read afterwards. */
export async function scaffold(options: ScaffoldOptions): Promise<Scaffolded> {
  const template = options.template ?? 'app'
  const name = options.name ?? basename(options.directory)
  if (!NAME.test(name)) {
    throw new Error(`E_BAD_NAME: '${name}' is not a package name. Lower case, digits, dot, dash, underscore`)
  }
  const from = join(TEMPLATES, template)
  let sources: string[]
  try {
    sources = await walk(from)
  } catch {
    throw new Error(`E_NO_TEMPLATE: '${template}' is not a template. Known: app, minimal`)
  }

  // A non-empty target is refused rather than merged. Scaffolding over somebody's work is the one
  // mistake this command could make that they cannot undo.
  try {
    const existing = await readdir(options.directory)
    if (existing.length) {
      throw new Error(
        `E_NOT_EMPTY: ${options.directory} already has ${existing.length} entries. Scaffolding into it would overwrite them`,
      )
    }
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error
  }

  const weftVersion = await version()
  const written: string[] = []

  for (const source of sources) {
    const rel = relative(from, source).split(sep)
    const last = rel.at(-1) as string
    rel[rel.length - 1] = RENAME[last] ?? last
    const target = join(options.directory, rel.join(sep))
    await mkdir(dirname(target), { recursive: true })
    const body = (await readFile(source, 'utf8'))
      .replaceAll('__NAME__', name)
      .replaceAll('__WEFT_VERSION__', weftVersion)
    await writeFile(target, body)
    written.push(rel.join('/'))
  }

  const where = relative(process.cwd(), options.directory) || '.'
  return {
    directory: options.directory,
    files: written.sort(),
    message: [
      '',
      `  ${name} — ${written.length} files`,
      '',
      ...written.sort().map((file) => `    ${file}`),
      '',
      '  Next',
      '',
      `    cd ${where}`,
      '    npm install',
      '    npm run dev',
      '',
    ].join('\n'),
  }
}
