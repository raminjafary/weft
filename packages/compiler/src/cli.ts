#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { explain, stringify } from '@weftjs/ir'
import { compileFiles } from './compile.ts'
import { CompileError } from './errors.ts'

const HELP = `weft-compile — template to versioned IR

  weft-compile <file.tsx…> [--out dir] [--quiet] [--no-types]

Writes one JSON document per template plus a manifest mapping template id to version.
Nested row templates are emitted alongside their parent.

Type information decides escape elision: a numeric or boolean value cannot contain
markup, so escaping it is a no-op the compiler can drop. --no-types falls back to the
syntax-only pass, which is correct and slower.
`

function slug(id: string): string {
  return id
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  if (!argv.length || argv.includes('--help')) {
    process.stdout.write(HELP)
    return argv.length ? 0 : 2
  }

  const files: string[] = []
  let out = 'build/ir'
  let quiet = false
  let types = true
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string
    if (token === '--out') {
      out = argv[++i] ?? out
    } else if (token === '--quiet') {
      quiet = true
    } else if (token === '--no-types') {
      types = false
    } else {
      files.push(token)
    }
  }

  await mkdir(out, { recursive: true })
  const manifest: Record<
    string,
    { version: string; file: string; forms: string[]; holes: number; wiring: number }
  > = {}

  const { modules, diagnostics } = await compileFiles(files, { types })
  if (diagnostics.length && !quiet) {
    process.stderr.write(`type diagnostics (elision falls back to escaping where a type is unknown):\n`)
    for (const line of diagnostics) process.stderr.write(`  ${line}\n`)
  }

  for (const compiled of modules) {
    const file = compiled.file
    if (!compiled.fragments.length && !quiet) {
      process.stderr.write(`${file}: no fragment() export found\n`)
    }
    for (const fragment of compiled.fragments) {
      for (const template of fragment.templates) {
        await writeFile(join(out, `${slug(template.id)}.json`), `${stringify(template)}\n`)
        manifest[template.id] = {
          version: template.version,
          file,
          forms: template.forms,
          holes: template.holes.length,
          wiring: template.wiring.length,
        }
        if (!quiet) {
          const elided = template.holes.filter((h) => h.escape === 'proven-safe').length
          process.stdout.write(
            `${template.version.slice(0, 8)}  ${template.holes.length} holes (${elided} elided)  ${template.wiring.length} wiring  ${template.id}\n` +
              `          ${explain(template.effects)}\n`,
          )
        }
      }
    }
  }

  await writeFile(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  if (!quiet) process.stdout.write(`\nwrote ${Object.keys(manifest).length} templates to ${out}\n`)
  return 0
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof CompileError) {
      process.stderr.write(`${error.message}\n`)
      process.exit(1)
    }
    process.stderr.write(`${(error as Error).stack ?? String(error)}\n`)
    process.exit(1)
  },
)
