import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * That the CLI's lines are lines.
 *
 * `weft upload` wrote 2231 bytes of report containing one newline: every per-object line and the
 * summary were concatenated, and the last of them ran into the shell prompt. It is the smallest
 * possible bug and it survived a release, because nothing that reads the output is a test — the
 * upload's own tests assert on the returned report, which was right all along.
 *
 * A source check rather than a spawned process, for the same reason the CLI page's test is one:
 * `weft upload` reads the build in `config.outDir` and there is no flag to move it, so a CLI run
 * here would race `demo/test/static.test.ts`, which empties that directory as it builds.
 */
const cli = readFileSync(fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'utf8')

/** One command's body: from its dispatch to the next one's. */
function branch(command: string): string {
  const start = cli.indexOf(`if (command === '${command}')`)
  assert.notEqual(start, -1, `no branch for ${command}`)
  const next = cli.indexOf('\n  if (command === ', start + 1)
  return cli.slice(start, next === -1 ? undefined : next)
}

/**
 * Every `out(...)` call, whole, and whether the text it writes ends a line.
 *
 * The whole call rather than its first template literal: these are built by concatenation and one of
 * them nests a template inside an interpolation, so anything less than balanced parentheses reads
 * the wrong half and calls a terminated line unterminated.
 *
 * A call with no literal in it at all is somebody else's formatter — `out(HELP)`,
 * `out(formatReport(...))` — and those end their own output. What this catches is a line written
 * here, by hand, with nothing at the end of it.
 */
function calls(source: string): string[] {
  const out: string[] = []
  for (let i = source.indexOf('out('); i !== -1; i = source.indexOf('out(', i + 1)) {
    // Not `process.stdout.write(` or a longer identifier ending in `out`.
    if (/[A-Za-z0-9_.]/.test(source[i - 1] ?? '')) continue
    let depth = 0
    let end = i + 3
    for (; end < source.length; end++) {
      const ch = source[end]
      if (ch === '(') depth++
      else if (ch === ')') {
        depth--
        if (depth === 0) break
      }
    }
    out.push(source.slice(i, end + 1))
  }
  return out
}

function unterminated(source: string): string[] {
  return (
    calls(source)
      // A call that hands its argument to a formatter — `out(banner(...))`, `out(formatReport(...))`,
      // `out(HELP)` — is not writing a line here; that function ends its own. Only a call that starts
      // with a literal is text built at the call site, which is the kind that shipped unterminated.
      .filter((call) => /^out\(\s*[`'"]/.test(call))
      .filter((call) => !call.includes('\\n'))
      .map((call) => call.replace(/\s+/g, ' ').slice(0, 70))
  )
}

test('every line the upload report writes ends with a newline', () => {
  const upload = branch('upload')
  assert.deepEqual(
    unterminated(upload),
    [],
    'a report whose lines are not lines is one line, and its last one runs into the prompt',
  )
  // The two writes that make up the report, named so a rewrite cannot quietly drop one.
  assert.match(upload, /object\.status\.padEnd\(8\)/, 'the per-object line')
  assert.match(upload, /uploaded, \$\{report\.skipped\} skipped/, 'the summary')
})

/** And the same for every other command, since the fix is a property rather than one command. */
test('no command writes a hand-built line without terminating it', () => {
  const commands = [...cli.matchAll(/if \(command === '([a-z-]+)'\)/g)].map((m) => m[1] as string)
  assert.ok(commands.length >= 9, `only ${commands.length} branches found`)
  const offenders: Record<string, string[]> = {}
  for (const command of commands) {
    const found = unterminated(branch(command))
    if (found.length) offenders[command] = found
  }
  assert.deepEqual(offenders, {})
})

/**
 * And what a refusal costs, which is the other half of a command-line tool being usable from a
 * script: a message on stderr and a non-zero status. `weft upload` with no `--to` is the case.
 */
test('a refusal goes to stderr with a newline, and the status is not zero', () => {
  const upload = branch('upload')
  assert.match(
    upload,
    /process\.stderr\.write\('weft upload needs --to <url>[^']*\\n'\)/,
    'the refusal names the missing flag and ends its line',
  )
  assert.match(upload, /return 2\n/, 'and answers 2, so a script can tell it was misused')
})

/**
 * What asking for help costs, which is nothing.
 *
 * `weft help` answered 0 and `weft --help` answered 2, because both land on the same line and only
 * the positional was consulted. Being run with no arguments at all is a misuse and 2 is right for
 * it; asking for the help text is a use of the tool. The difference matters to a `set -e` script and
 * to any smoke test that runs `weft --help` to check the binary resolves.
 */
test('asking for help succeeds, and being run with nothing does not', () => {
  const help = cli.slice(cli.indexOf('async function main'), cli.indexOf('const root ='))
  assert.match(help, /flags\.help/, 'the flag is what asking for help looks like')
  assert.match(
    help,
    /return command \|\| flags\.help \? 0 : 2/,
    'a named command or an explicit --help is a success; nothing at all is a misuse',
  )
})
