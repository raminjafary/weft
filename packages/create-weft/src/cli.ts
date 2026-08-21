#!/usr/bin/env node
import { resolve } from 'node:path'
import { scaffold, type Template } from 'weft/server'

/**
 * `npm create weft`.
 *
 * A shim, deliberately. The templates and the scaffolder live in the framework package, because a
 * scaffold that ships its own copy of them is a scaffold that will generate an application the
 * framework has stopped supporting.
 */
const HELP = `create-weft — a new weft application

  npm create weft <name> [-- --template minimal]

  --template  app | minimal   (default app)
`

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP)
    return 0
  }
  let template: Template = 'app'
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string
    if (token === '--template') {
      template = (argv[++i] ?? 'app') as Template
      continue
    }
    if (token.startsWith('--')) continue
    positional.push(token)
  }
  const name = positional[0]
  if (!name) {
    process.stderr.write(HELP)
    return 2
  }
  const created = await scaffold({ directory: resolve(name), name, template })
  process.stdout.write(created.message)
  return 0
}

main().then(
  (code) => {
    if (code !== 0) process.exit(code)
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(/^E_[A-Z_]+/.test(message) ? `\n  ${message}\n\n` : `${(error as Error).stack}\n`)
    process.exit(1)
  },
)
