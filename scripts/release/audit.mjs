import { auditPack, humanBytes } from './lib/pack.mjs'
import { ReleaseError, bad, bold, dim, ok, parseArgs, say, step } from './lib/shell.mjs'
import { loadWorkspace, publishOrder } from './lib/workspace.mjs'

const FLAGS = ['verbose', 'help']

const USAGE = `
${bold('pnpm pack:audit')}   pack every published package and check what came out
  --verbose   list every file in every tarball
`

/** The tarball check, on its own — worth having before a release runs it. See `lib/pack.mjs`. */
function main() {
  const { flags } = parseArgs(process.argv.slice(2), FLAGS)
  if (flags.help) return say(USAGE)

  const packages = loadWorkspace()
  const order = publishOrder(packages)

  let problems = 0
  let total = 0
  for (const name of order) {
    const pkg = packages.get(name)
    step(`${name}@${pkg.version}`)
    const audit = auditPack(pkg)
    total += audit.bytes
    say(`  ${audit.entries.length} files, ${humanBytes(audit.bytes)}`)
    if (flags.verbose) for (const entry of audit.entries) say(dim(`    ${entry.replace(/^package\//, '')}`))
    if (audit.problems.length) {
      problems += audit.problems.length
      for (const problem of audit.problems) bad(problem)
    } else {
      ok('nothing in it that should not be')
    }
  }

  say('')
  if (problems) {
    say(`${problems} problem(s) across ${order.length} package(s). ${bold('This would not release.')}\n`)
    process.exit(1)
  }
  say(`${order.length} package(s), ${humanBytes(total)} in total. Clean.\n`)
}

try {
  main()
} catch (error) {
  say('')
  bad(error instanceof ReleaseError ? error.message : (error?.stack ?? String(error)))
  say('')
  process.exit(1)
}
