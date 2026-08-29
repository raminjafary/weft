import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The rule that makes portability a property rather than a porting exercise: the kernel imports
 * nothing but the WinterTC Minimum Common Web API. See `spec/kernel/ports.md`.
 */
const SRC = fileURLToPath(new URL('../src/', import.meta.url))

const BANNED_GLOBALS = [
  /\bprocess\s*\./,
  /\bBuffer\b/,
  /(?:^|[^.\w])require\s*\(/m,
  /\b__dirname\b/,
  /\bglobalThis\.process\b/,
]

function sources(): { file: string; text: string }[] {
  return readdirSync(SRC)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ file: name, text: readFileSync(SRC + name, 'utf8') }))
}

test('the kernel imports no host runtime', () => {
  const offenders: string[] = []
  for (const { file, text } of sources()) {
    for (const match of text.matchAll(/from\s+'(node:[^']+)'/g)) offenders.push(`${file}: ${match[1]}`)
  }
  assert.deepEqual(offenders, [])
})

/**
 * Code, with comments removed — this gate is about what the kernel *touches*, and it once fired
 * on a comment explaining why a helper was not using `Buffer`.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

test('the kernel touches no host global', () => {
  const offenders: string[] = []
  for (const { file, text } of sources()) {
    const code = stripComments(text)
    for (const pattern of BANNED_GLOBALS) {
      if (pattern.test(code)) offenders.push(`${file}: ${String(pattern)}`)
    }
  }
  assert.deepEqual(offenders, [])
})

test('the comment-stripping does not blind the gate', () => {
  // The gate above is only trustworthy if what it strips is comments and not code, so the
  // stripping is checked directly rather than trusted.
  const stripped = stripComments('const a = 1 // process.env\n/* Buffer */\nconst b = process.env.X\n')
  assert.match(stripped, /process\.env\.X/)
  assert.doesNotMatch(stripped, /Buffer/)
})

test('the kernel only reaches sideways into the two versioned wire packages', () => {
  const allowed = /^\.\.\/\.\.\/(ir|warp)\/src\//
  const offenders: string[] = []
  for (const { file, text } of sources()) {
    for (const match of text.matchAll(/from\s+'(\.\.\/[^']+)'/g)) {
      const specifier = match[1] as string
      if (!allowed.test(specifier)) offenders.push(`${file}: ${specifier}`)
    }
  }
  assert.deepEqual(offenders, [])
})

/**
 * A smell detector for the kernel absorbing work that belongs in a port — not the byte budget,
 * which is in `@weftjs/bench`. Counts **code** lines only. See `spec/kernel/budgets.md` for why
 * this exists and the commitment that a fourth re-derivation means deleting it rather than
 * fixing it again.
 */
const LINE_CEILINGS: Record<string, number> = {
  'entry-request.ts': 1850,
  'entry-nested.ts': 1900,
  'entry-channel.ts': 2200,
  'entry-patch.ts': 2200,
  'entry-intent.ts': 2200,
  'entry-transport.ts': 2650,
  'entry-stage.ts': 2750,
  'entry-journal.ts': 2700,
  'entry-authority.ts': 2600,
  'entry-discover.ts': 2800,
  'entry-render.ts': 2850,
  'entry-region.ts': 2200,
  'entry-region-channel.ts': 3100,
}

/** Code only. A comment is not work the kernel absorbed from a port. */
function codeLines(text: string): number {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//')).length
}

/**
 * The request path is what the 8 KB claim is measured against, so what may enter it is a rule and
 * not a preference. Reachability, not a grep — a module three imports deep is in the request path
 * exactly as much as one imported directly. See `spec/kernel/budgets.md`.
 */
const OFF_THE_REQUEST_PATH: Record<string, string> = {
  'plugin-graph.ts': 'build-time: plugin ordering is inferred from static declarations',
  'plugin-guard.ts': 'dev-time: the design specifies declared-read enforcement as a dev check',
  'coalesce.ts':
    'opt-in: the kernel names the stampede seam, and the good version of the policy is store-specific',
  'region-tree.ts':
    'deploy-time: a subtree is announced when something asks what the topology is, and no request does',
}

function localImports(text: string): string[] {
  const out: string[] = []
  for (const match of text.matchAll(/(?:import|export)\s+([^']*?)\s*from\s+'\.\/([^']+)'/g)) {
    // A type-only import contributes no bytes and no behaviour, so it is not the path.
    if (/^type\b/.test((match[1] as string).trim())) continue
    out.push(match[2] as string)
  }
  return out
}

function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length) {
    const file = queue.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    for (const next of localImports(readFileSync(SRC + file, 'utf8'))) {
      if (!seen.has(next)) queue.push(next)
    }
  }
  return seen
}

test('the document request path reaches no build-time or dev-only module', () => {
  const reached = reachableFrom('entry-request.ts')
  const offenders = Object.keys(OFF_THE_REQUEST_PATH).filter((file) => reached.has(file))
  assert.deepEqual(offenders, [], 'reachable from entry-request.ts, so a production request pays for it')
})

test('the excluded modules exist, so the gate above is checking something', () => {
  const names = new Set(sources().map(({ file }) => file))
  for (const file of Object.keys(OFF_THE_REQUEST_PATH)) {
    assert.ok(names.has(file), `${file} is named as off the request path but does not exist`)
  }
})

test('the barrel does reach them, so the walk is finding real edges', () => {
  const reached = reachableFrom('index.ts')
  for (const file of Object.keys(OFF_THE_REQUEST_PATH)) {
    assert.ok(reached.has(file), `the walk did not find ${file} from the barrel, which exports it`)
  }
})

test('each entry is small enough for what it is', () => {
  const over: string[] = []
  for (const [entry, ceiling] of Object.entries(LINE_CEILINGS)) {
    const lines = [...reachableFrom(entry)].reduce(
      (sum, file) => sum + codeLines(readFileSync(SRC + file, 'utf8')),
      0,
    )
    if (lines >= ceiling) over.push(`${entry}: ${lines} lines against ${ceiling}`)
  }
  assert.deepEqual(over, [])
})

test('every source file is reachable from an entry or named as off the request path', () => {
  // Otherwise a module can be added, gated by nothing, and be perfectly invisible to both
  // the byte budget and the line count.
  const reached = new Set<string>()
  for (const entry of Object.keys(LINE_CEILINGS)) for (const file of reachableFrom(entry)) reached.add(file)
  const orphans = sources()
    .map(({ file }) => file)
    .filter((file) => file !== 'index.ts' && !reached.has(file) && !(file in OFF_THE_REQUEST_PATH))
  assert.deepEqual(orphans, [], 'reachable from no entry, so no ceiling applies to it')
})
