#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { stringify } from '../../ir/src/index.ts'
import { compileFile } from './compile.ts'
import { CompileError } from './errors.ts'

const HELP = `weft-compile — template to versioned IR

  weft-compile <file.tsx…> [--out dir] [--quiet]

Writes one JSON document per template plus a manifest mapping template id to version.
Nested row templates are emitted alongside their parent.
`

function slug(id: string): string {
  return id.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()
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
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string
    if (token === '--out') {
      out = argv[++i] ?? out
    } else if (token === '--quiet') {
      quiet = true
    } else {
      files.push(token)
    }
  }

  await mkdir(out, { recursive: true })
  const manifest: Record<string, { version: string; file: string; forms: string[]; holes: number; wiring: number }> = {}

  for (const file of files) {
    const compiled = await compileFile(file)
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
          process.stdout.write(
            `${template.version.slice(0, 8)}  ${template.holes.length} holes  ${template.wiring.length} wiring  ${template.forms.join(',')}  ${template.id}\n`,
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
