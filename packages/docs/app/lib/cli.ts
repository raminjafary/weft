import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The CLI reference, read out of the string the CLI prints.
 *
 * `weft --help` is already a reference somebody maintains, because a flag that is not in it is a
 * flag nobody can find. A second copy of it on this site would be a second copy that drifts, so
 * this parses the first one: `HELP` in `packages/weft/src/cli.ts`, which is the same text the
 * terminal shows.
 *
 * `test/docs.test.ts` checks it the other way round — every `case` the argument switch handles has
 * to appear here — so a command that is implemented and undocumented fails the build rather than
 * being a command only its author knows about.
 */
export interface CliCommand {
  /** `dev`, `build`, `why`. The word after `weft`. */
  name: string
  /** The usage line as written, arguments included. */
  usage: string
  summary: string
}

export interface CliOption {
  /** `--port <n>`, as written. */
  flag: string
  summary: string
  /** The command this one is only for, when the help text says so. */
  only?: string
}

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const SOURCE = join(ROOT, 'packages/weft/src/cli.ts')

function helpText(): string {
  const source = readFileSync(SOURCE, 'utf8')
  const start = source.indexOf('const HELP = `')
  if (start < 0) throw new Error('E_DOCS_NO_HELP: cli.ts no longer declares a HELP template')
  const from = start + 'const HELP = `'.length
  const end = source.indexOf('`', from)
  if (end < 0) throw new Error('E_DOCS_NO_HELP: the HELP template is not terminated')
  return source.slice(from, end)
}

/** The line the CLI opens with, which is the shortest true description of the tool. */
export function tagline(): string {
  return (helpText().split('\n')[0] ?? '').replace(/^weft — /, '')
}

/**
 * Every command, in the order the help text lists them.
 *
 * The shape parsed is `weft <name> [args]   summary`, which is a convention the help text keeps
 * because it is meant to be read in a terminal. Two spaces separate the usage from its summary.
 */
export function commands(): CliCommand[] {
  const out: CliCommand[] = []
  for (const line of helpText().split('\n')) {
    const match = /^\s{2}weft (\S+)([^\s].*?|.*?)\s{2,}(\S.*)$/.exec(line)
    if (!match) continue
    const [, name, rest, summary] = match
    out.push({
      name: name as string,
      usage: `weft ${name}${rest}`.trim(),
      summary: (summary as string).trim(),
    })
  }
  return out
}

/**
 * Every option, with the command it belongs to when it belongs to one.
 *
 * The help text says "upload only" in the summary, so that is where the association comes from
 * rather than a second table here that could disagree with it.
 */
export function options(): CliOption[] {
  const out: CliOption[] = []
  let seenOptions = false
  for (const line of helpText().split('\n')) {
    if (line.startsWith('Options')) {
      seenOptions = true
      continue
    }
    if (!seenOptions) continue
    const match = /^\s{2}(--\S+(?: <[^>]+>)?)\s{2,}(\S.*)$/.exec(line)
    if (!match) continue
    const [, flag, summary] = match
    const text = (summary as string).trim()
    const only = /^([a-z]+) only: /.exec(text)
    out.push({
      flag: flag as string,
      summary: only ? text.slice(only[0].length) : text,
      ...(only ? { only: only[1] as string } : {}),
    })
  }
  return out
}
