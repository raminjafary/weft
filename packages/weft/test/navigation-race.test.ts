import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * A navigation that was overtaken while it waited, and the two things it must not do.
 *
 * The bug: a staged route is claimed with no deadline, deliberately — waiting for a request
 * already in flight cannot cost more than throwing it away and issuing the same one. What that
 * leaves is a reader who clicks a slow route and then clicks others. The first claim settles last,
 * and it painted last too: the reader landed on the page they had already changed their mind
 * about, seconds after the one they wanted had appeared.
 *
 * Both halves of the fix are orderings, which is why they are asserted as orderings rather than as
 * the presence of a line. The ticket has to be checked *after* the wait and *before* the paint —
 * checked anywhere else it is decoration. And a superseded navigation has to return before
 * `location.assign`, because the fallback that is right for a route nobody staged is exactly wrong
 * for one the reader has moved on from: it would send the browser to the abandoned URL.
 *
 * Source inspection rather than a browser test, on the rule `navigated.test.ts` sets out: `boot.ts`
 * is a browser bundle with a byte budget the build enforces, so exporting its internals to make
 * them reachable from here would be bytes on every page of every application to save a regex.
 */
const boot = readFileSync(fileURLToPath(new URL('../src/client/boot.ts', import.meta.url)), 'utf8')

function slice(from: string, to: string): string {
  const start = boot.indexOf(from)
  assert.notEqual(start, -1, `${from} is not in boot.ts any more`)
  const end = boot.indexOf(to, start)
  assert.notEqual(end, -1, `${to} is not after ${from} any more`)
  return boot.slice(start, end)
}

test('every navigation takes a ticket, and staging does not', () => {
  assert.match(boot, /let navSeq = 0/, 'there is a current navigation, and it is a number')
  const go = slice('async function go(', 'function announceNavigation')
  assert.match(go, /const mine = \+\+navSeq/, 'a navigation claims the ticket when it starts')
  /**
   * And nothing else claims it. Hovering a link changes nothing about where the reader is going, so
   * if `routes.stage` bumped the ticket a hover over any other link would cancel the click already
   * in flight — the same bug, arriving from the other side. One bump, and it is this one.
   */
  const bumps = boot.split('++navSeq').length - 1
  assert.equal(bumps, 1, 'exactly one thing takes the ticket')
  assert.equal(go.split('++navSeq').length - 1, 1, 'and it is the navigation, not staging')
})

test('the ticket is checked between the waiting and the painting, which is the only place it works', () => {
  const go = slice('async function go(', 'function announceNavigation')
  const claim = go.indexOf('await routes.claim')
  const check = go.indexOf('mine !== navSeq')
  const paint = go.indexOf('commitRegions')
  assert.notEqual(check, -1, 'the ticket is checked at all')
  assert.ok(claim < check, 'checked after the wait — before it, nothing has had time to overtake')
  assert.ok(check < paint, 'and before the paint, or the wrong page is already on screen')
  assert.match(go, /return 'stale'/, 'and says which of the three outcomes this was')
})

test('a superseded navigation does not paint and does not load the document either', () => {
  const nav = slice('async function navigate(', 'A link the reader has been looking at')
  const stale = nav.indexOf("went === 'stale'")
  // The call, not the word: this function's own comment explains the fallback before it reaches it.
  const assign = nav.indexOf('window.location.assign(')
  assert.notEqual(stale, -1, 'navigate distinguishes overtaken from never-staged')
  assert.ok(
    stale < assign,
    'and returns before the fallback, which would send the reader to the abandoned URL',
  )
})

test('a history traversal is overtaken the same way, rather than reloading over the newer one', () => {
  const pop = slice("addEventListener('popstate'", 'window.location.reload()')
  assert.match(
    pop,
    /!== 'cold'/,
    'only a route nothing was staged for reloads: painted and stale both return',
  )
})
