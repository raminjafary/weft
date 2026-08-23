import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The rule that makes portability a property rather than a porting exercise: the kernel
 * imports nothing but the WinterTC Minimum Common Web API. Anything outside it — a
 * filesystem, a socket, `process`, `Buffer`, Node timer semantics — reaches the kernel
 * through a port and lives in an adapter.
 *
 * This is a gate rather than a paragraph, because a rule stated in a design document and
 * not checked in CI is a rule that lasts until the first inconvenient afternoon.
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
 * Code, with comments removed — because this gate is about what the kernel *touches*, and a
 * sentence naming `Buffer` to say the kernel does not use it touches nothing.
 *
 * It fired on exactly that: a base64url helper whose comment explained why it was not using the
 * Node global. The line-count check in this file already learned this lesson the same way, and a
 * check that fires when somebody explains the rule teaches people to stop explaining it.
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
 * The line count is a smell detector for the kernel absorbing work that belongs in a port. It
 * is not the byte budget — that is in `@weft/bench` — and it has now been re-derived three
 * times, each time because it was measuring something other than what it claims to.
 *
 * First it summed every file in `src/`, so routing appeared to blow it and the ceiling was
 * moved from 2,500 to 2,900. That was the gross-versus-marginal mistake the byte budget had
 * already made and fixed, so it became per entry by reachability.
 *
 * Then it fired on backpressure and a pair of TTLs — and 30% of what it was counting was
 * documentation. A detector meant to catch absorbed work that fires when somebody explains
 * the work is not measuring absorbed work. So it counts **code** lines: comments and blank
 * lines are stripped before counting.
 *
 * The honest position after three of these: the byte budget is the gate and this is a weak
 * heuristic that has cost more attention than it has earned. It survives because a kernel that
 * doubles in code with no byte change is still worth being told about. **If it needs a fourth
 * re-derivation it should be deleted rather than fixed**, and that is a commitment, not a
 * caveat.
 */
const LINE_CEILINGS: Record<string, number> = {
  'entry-request.ts': 1800,
  'entry-channel.ts': 2100,
  'entry-intent.ts': 2100,
  'entry-transport.ts': 2500,
  // A route staged over the channel: the transport plus `stage.ts`, and its own entry for the same
  // reason the transport has one — it went past a watermark set before it existed.
  'entry-stage.ts': 2600,
  // Authority: the intent path plus a capability model and signed intents. The tier the design
  // calls separable, so it gets a ceiling it can be reviewed against rather than a share of the
  // intent path's.
  'entry-authority.ts': 2500,
  // Lazy plan extension, on top of route staging. The whole capability is one module.
  'entry-discover.ts': 2700,
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
 * The request path is what the 8 KB claim is measured against, so what may enter it is a rule
 * and not a preference. Three kinds of module are excluded, each with its reason recorded next
 * to it: work that has no request to do it for, checks the design specifies as dev-time, and
 * policy the kernel deliberately does not have an opinion about.
 *
 * Reachability, not a grep. A module three imports deep is in the request path exactly as
 * much as one imported directly, and that is the mistake this catches.
 */
const OFF_THE_REQUEST_PATH: Record<string, string> = {
  'plugin-graph.ts': 'build-time: plugin ordering is inferred from static declarations',
  'plugin-guard.ts': 'dev-time: the design specifies declared-read enforcement as a dev check',
  'coalesce.ts':
    'opt-in: the kernel names the stampede seam, and the good version of the policy is store-specific',
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
