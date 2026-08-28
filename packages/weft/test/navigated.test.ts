import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * `weft:navigated`, and the fact that two files have to agree about its name.
 *
 * The runtime swaps the DOM on a staged navigation, so an application's own `client.ts` — imported
 * once, at boot — has no way to know the markup it wired itself to has been replaced. Every
 * application that ships a client module and a router needs to be told; the framework owes it an
 * event rather than leaving each of them to re-derive one from `popstate` and a MutationObserver.
 *
 * Why this is a string check and not a browser test. The event name could be a shared constant both
 * sides import, and that would be the better shape everywhere except here: `boot.ts` is a browser
 * bundle with a byte budget the build enforces, and an import for a fourteen-character string is
 * bytes on every page of every application to save one assertion. So the string is written twice
 * and this is what makes the second copy safe.
 */
const boot = readFileSync(fileURLToPath(new URL('../src/client/boot.ts', import.meta.url)), 'utf8')
const docsClient = readFileSync(fileURLToPath(new URL('../../docs/app/client.ts', import.meta.url)), 'utf8')

test('the runtime announces a navigation it answered, on the document', () => {
  assert.match(
    boot,
    /new CustomEvent\('weft:navigated'/,
    'a staged navigation replaces the markup, so it has to say so',
  )
  assert.match(boot, /document\.dispatchEvent\(/, 'on the document, which survives a region swap')
})

test('the detail says where and how, because the two answers differ', () => {
  const announce = boot.slice(boot.indexOf('function announceNavigation'))
  for (const key of ['url', 'pathname', 'search', 'kind']) {
    assert.match(announce, new RegExp(`\\b${key}:`), `the detail carries ${key}`)
  }
  assert.match(
    boot,
    /kind: 'regions' \| 'document'/,
    'kind distinguishes a document that survived from one that was replaced',
  )
})

test('the application that listens for it listens for the same name', () => {
  assert.match(
    docsClient,
    /addEventListener\('weft:navigated'/,
    'the docs site re-wires on it; a rename here that missed it would be silent',
  )
})

/**
 * And it is announced before the channel is rebound, which is the difference between a
 * re-wire and a flash.
 *
 * A commit ends by telling the server where this client is now, and that is a POST. The event used
 * to be fired after the commit returned, so every listener ran a network round trip after the new
 * document was already on screen — and everything a listener restores was missing for that long.
 * On this project's own site the reader's chosen theme reverted to the server's default for the
 * length of a request and then corrected itself, and the theme control, which the stylesheet gates
 * on a flag an inline script sets, disappeared and came back. Nothing was broken. Both were late.
 *
 * The ordering is the fix and the ordering is what this asserts: after the scroll has landed, and
 * before `rebind`. Then the listener's DOM writes land in the same frame as the swap.
 */
function slice(from: string, to: string): string {
  const start = boot.indexOf(from)
  assert.notEqual(start, -1, `${from} is not in boot.ts any more`)
  const end = boot.indexOf(to, start)
  assert.notEqual(end, -1, `${to} is not after ${from} any more`)
  return boot.slice(start, end)
}

for (const commit of ['async function commitRegions(', 'async function commitPage(']) {
  test(`${commit.includes('Regions') ? 'a region swap' : 'a document swap'} announces before it rebinds`, () => {
    const body = slice(commit, 'return painted')
    const announced = body.indexOf('announceNavigation(')
    const rebound = body.indexOf('await rebind(')
    assert.notEqual(announced, -1, 'the commit announces the navigation itself')
    assert.notEqual(rebound, -1, 'and still rebinds')
    assert.ok(announced < rebound, 'the application heard about the swap a round trip after it painted')
  })
}

/**
 * And exactly once. Announcing from the commit *and* from `go` would fire the event twice per
 * navigation, which for a listener that rebinds controls is every control bound twice.
 */
test('a navigation is announced once', () => {
  assert.equal(
    boot.split('announceNavigation(').length - 1,
    3,
    'announceNavigation is defined once and called once per commit path, and no more',
  )
})
