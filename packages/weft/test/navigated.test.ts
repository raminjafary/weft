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
