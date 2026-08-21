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
