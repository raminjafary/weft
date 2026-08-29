import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The CLI reference, parsed from `HELP` in `packages/weft/src/cli.ts` — the same text the terminal
 * shows, not a second copy that drifts. `docs.test.ts` checks the reverse too: every `case` the
 * switch handles must appear here.
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

/** Every command, in help-text order. Parses `weft <name> [args]   summary` — two spaces separate usage from summary. */
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

/** Every option, with its command when it has one — the association comes from the help text's own summary (e.g. "upload only"), not a second table. */
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
