import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createKnown, discoverFrame, planFrames, rankOf, type KnownRoute } from '../src/discover.ts'

/**
 * What the client does with a plan it has been handed.
 *
 * The whole value of this module is a decision taken *without* a round trip, so what is asserted is
 * that the decision agrees with the one the server would have made: the same specificity rule, and
 * the same answer about which document a route renders into.
 */
const ROUTES: KnownRoute[] = [
  { pattern: '/', shell: 'sh-main', shared: true },
  { pattern: '/product/new', shell: 'sh-main', shared: true },
  { pattern: '/product/:sku', shell: 'sh-main', shared: true },
  { pattern: '/checkout/pay', shell: 'sh-narrow', shared: false, css: '/pay.css' },
  { pattern: '/docs/*', shell: 'sh-main', shared: true },
]

function plan(
  routes: KnownRoute[],
  header: Record<string, string | number | boolean> = {},
): {
  kind: string
  header: Record<string, string | number | boolean>
  body?: Uint8Array
} {
  return { kind: 'PLAN', header, body: new TextEncoder().encode(JSON.stringify(routes)) }
}

test('specificity decides, the way it does on the server', () => {
  // Static beats a param, a param beats a wildcard. A client that decided otherwise would answer a
  // click on the strength of a route the server would not have chosen.
  const known = createKnown()
  known.learn(ROUTES)
  assert.equal(known.route('/product/new')?.pattern, '/product/new')
  assert.equal(known.route('/product/RICE-5K')?.pattern, '/product/:sku')
  assert.equal(known.route('/docs/guides/forms')?.pattern, '/docs/*')
  assert.equal(known.route('/nothing/here'), undefined)
})

test('a pattern that cannot match the path ranks below nothing', () => {
  assert.equal(rankOf('/product/:sku', '/product'), -1)
  assert.equal(rankOf('/product/:sku', '/product/a/b'), -1)
  // `/docs` matches `/docs/*` with an empty rest, which is what the server's matcher does — the
  // point of this rule being written twice is that the two agree, including here.
  assert.ok(rankOf('/docs/*', '/docs') > 0)
  assert.ok(rankOf('/product/new', '/product/new') > rankOf('/product/:sku', '/product/new'))
})

test('a trailing slash is not a different route', () => {
  const known = createKnown()
  known.learn(ROUTES)
  assert.equal(known.route('/product/new/')?.pattern, '/product/new')
  assert.equal(known.route('/')?.pattern, '/')
})

test('the shell is the answer worth having in advance', () => {
  const known = createKnown()
  known.learn(ROUTES)
  assert.equal(known.route('/product/RICE-5K')?.shared, true, 'this one can arrive as regions')
  assert.equal(known.route('/checkout/pay')?.shared, false, 'and this one cannot, with no WARM spent')
})

test('a pattern arriving twice replaces what was held for it', () => {
  const known = createKnown()
  known.learn([{ pattern: '/', shell: 'sh-old', shared: false }])
  known.learn([{ pattern: '/', shell: 'sh-new', shared: true }])
  assert.equal(known.size, 1)
  assert.equal(known.route('/')?.shell, 'sh-new')
})

test('a prefix is asked about once', () => {
  const known = createKnown()
  assert.equal(known.asked('/checkout/*'), false)
  known.ask('/checkout/*')
  assert.equal(known.asked('/checkout/*'), true)
})

test('a PLAN frame lands in the registry, and its completeness is carried through', () => {
  const known = createKnown()
  const arrivals: { prefix: string; complete: boolean; count: number }[] = []
  const route = planFrames(known, (arrival) =>
    arrivals.push({ prefix: arrival.prefix, complete: arrival.complete, count: arrival.routes.length }),
  )

  route(plan(ROUTES, { p: '/', n: 5, complete: true }))
  route(plan(ROUTES.slice(0, 1), { p: '/checkout/*', n: 1, complete: false }))
  assert.deepEqual(arrivals, [
    { prefix: '/', complete: true, count: 5 },
    { prefix: '/checkout/*', complete: false, count: 1 },
  ])
  assert.equal(known.size, 5)
})

test('a frame that is not a PLAN, and a body this build cannot read, both do nothing', () => {
  const known = createKnown()
  let called = 0
  const route = planFrames(known, () => called++)
  route({ kind: 'NAV', header: { at: '/' } })
  route({ kind: 'PLAN', header: {}, body: new TextEncoder().encode('not json') })
  assert.equal(called, 0)
  assert.equal(known.size, 0, 'a hint that cannot be read is not a page worth breaking')
})

test('an empty PLAN is an answer', () => {
  const known = createKnown()
  const seen: number[] = []
  const route = planFrames(known, (arrival) => seen.push(arrival.routes.length))
  route({ kind: 'PLAN', header: { p: '/admin/*', n: 0 } })
  assert.deepEqual(seen, [0], 'the client learns this subtree is not the application’s and stops asking')
})

test('the frame that asks is a WARM at the plan grain', () => {
  assert.deepEqual(discoverFrame('/checkout/*'), { kind: 'WARM', header: { plan: '/checkout/*' } })
})
