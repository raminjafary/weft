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

test('the kernel touches no host global', () => {
  const offenders: string[] = []
  for (const { file, text } of sources()) {
    for (const pattern of BANNED_GLOBALS) {
      if (pattern.test(text)) offenders.push(`${file}: ${String(pattern)}`)
    }
  }
  assert.deepEqual(offenders, [])
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

test('the kernel is small enough to be a kernel', () => {
  const lines = sources().reduce((sum, { text }) => sum + text.split('\n').length, 0)
  // The gate that matters is the 8 KB byte budget in `@weft/bench`, measured against the
  // document request path. This is a shape check on top of it: it fires when the kernel starts
  // absorbing work that belongs in a port, and it is allowed to move when the thing added is
  // one of the four jobs a kernel has. Routing was, so it moved from 2,500 to 2,900.
  assert.ok(lines < 2900, `kernel source is ${lines} lines`)
})

/**
 * The request path is what the 8 KB claim is measured against, so what may enter it is a
 * rule and not a preference. Two kinds of module are excluded by name: work that has no
 * request to do it for — a plugin ordering graph, resolved once at build — and checks the
 * design specifies as dev-time, which a production request should not pay for.
 *
 * Reachability, not a grep. A module three imports deep is in the request path exactly as
 * much as one imported directly, and that is the mistake this catches.
 */
const OFF_THE_REQUEST_PATH = ['plugin-graph.ts', 'plugin-guard.ts']

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
  const offenders = OFF_THE_REQUEST_PATH.filter((file) => reached.has(file))
  assert.deepEqual(offenders, [], 'reachable from entry-request.ts, so a production request pays for it')
})

test('the excluded modules exist, so the gate above is checking something', () => {
  const names = new Set(sources().map(({ file }) => file))
  for (const file of OFF_THE_REQUEST_PATH) {
    assert.ok(names.has(file), `${file} is named as off the request path but does not exist`)
  }
})

test('the barrel does reach them, so the walk is finding real edges', () => {
  const reached = reachableFrom('index.ts')
  for (const file of OFF_THE_REQUEST_PATH) {
    assert.ok(reached.has(file), `the walk did not find ${file} from the barrel, which exports it`)
  }
})
