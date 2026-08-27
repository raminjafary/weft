import { spawnSync } from 'node:child_process'

const styles = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
}

const enabled = process.stdout.isTTY && !process.env.NO_COLOR

const paint = (name, text) => (enabled ? `${styles[name]}${text}${styles.reset}` : text)

export const dim = (text) => paint('dim', text)
export const bold = (text) => paint('bold', text)

export const say = (text = '') => process.stdout.write(`${text}\n`)
export const step = (text) => say(`\n${paint('blue', '▶')} ${bold(text)}`)
export const ok = (text) => say(`  ${paint('green', '✓')} ${text}`)
export const warn = (text) => say(`  ${paint('yellow', '!')} ${text}`)
export const bad = (text) => say(`  ${paint('red', '✗')} ${text}`)

/** A failure the operator caused or can fix, printed without a stack trace. */
export class ReleaseError extends Error {}

export function fail(message) {
  throw new ReleaseError(message)
}

/**
 * Run a command and return its output, or throw with the command's own error text.
 *
 * Release steps fail for boring reasons — a missing binary, an expired token, a tag that already
 * exists — and a stack trace pointing into this file hides the line that actually explains it.
 */
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.error) fail(`${command}: ${result.error.message}`)
  const stdout = (result.stdout ?? '').trim()
  const stderr = (result.stderr ?? '').trim()
  // Both, for a message a human reads; `stdout` alone for anything parsed. Merging them is what
  // broke a release: run under pnpm, npm warns on stderr about an env config pnpm sets, and that
  // line then arrived inside every JSON.parse and every `whoami` this file feeds a comparison.
  const output = [stdout, stderr].filter(Boolean).join('\n')
  if (result.status !== 0) {
    if (options.allowFailure) return { ok: false, stdout, stderr, output, status: result.status }
    fail(`${command} ${args.join(' ')} exited ${result.status}\n\n${output}`)
  }
  return { ok: true, stdout, stderr, output, status: 0 }
}

/** Run a command with its output on this terminal, for gates whose progress is the point. */
export function runVisible(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error) fail(`${command}: ${result.error.message}`)
  if (result.status !== 0 && !options.allowFailure) {
    fail(`${command} ${args.join(' ')} exited ${result.status}`)
  }
  return { ok: result.status === 0, status: result.status }
}

export const git = (...args) => run('git', args).stdout

/**
 * Flags, without a parser dependency.
 *
 * `--flag` is true, `--key=value` is a string, everything else is a positional. An unrecognised
 * flag is an error rather than a no-op, because `--dryrun` silently publishing to the registry is
 * the one mistake this tooling exists to prevent.
 */
export function parseArgs(argv, known) {
  const flags = {}
  const positional = []
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const [name, ...rest] = arg.slice(2).split('=')
    if (!known.includes(name)) fail(`unknown flag --${name}. Known: ${known.map((k) => `--${k}`).join(', ')}`)
    flags[name] = rest.length ? rest.join('=') : true
  }
  return { flags, positional }
}
