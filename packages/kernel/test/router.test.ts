import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRouter } from '../src/index.ts'

const table = () =>
  createRouter([
    { pattern: '/', value: 'home' },
    { pattern: '/cart', value: 'cart' },
    { pattern: '/product/new', value: 'new-product' },
    { pattern: '/product/:sku', value: 'product' },
    { pattern: '/product/:sku/reviews', value: 'reviews' },
    { pattern: '/checkout/*', value: 'checkout' },
  ])

test('a static path matches with no params', () => {
  const matched = table().match('/cart')
  assert.equal(matched?.value, 'cart')
  assert.deepEqual(matched?.params, {})
})

test('the root is the one path that is only a slash', () => {
  assert.equal(table().match('/')?.value, 'home')
  assert.equal(table().match('')?.value, 'home')
})

test('a param is captured under its name', () => {
  const matched = table().match('/product/rice-5kg')
  assert.equal(matched?.value, 'product')
  assert.deepEqual(matched?.params, { sku: 'rice-5kg' })
})

test('specificity decides, not declaration order', () => {
  // '/product/new' is declared before '/product/:sku' here and after it in the reversed
  // table; both have to answer the same way.
  const forward = table().match('/product/new')
  const reversed = createRouter([
    { pattern: '/product/:sku', value: 'product' },
    { pattern: '/product/new', value: 'new-product' },
  ]).match('/product/new')
  assert.equal(forward?.value, 'new-product')
  assert.equal(reversed?.value, 'new-product')
})

test('a param beats a wildcard at the same depth', () => {
  const router = createRouter([
    { pattern: '/a/*', value: 'wild' },
    { pattern: '/a/:id', value: 'param' },
  ])
  assert.equal(router.match('/a/7')?.value, 'param')
  assert.equal(router.match('/a/7/8')?.value, 'wild')
})

test('a wildcard captures the rest of the path under *', () => {
  const matched = table().match('/checkout/payment/card')
  assert.equal(matched?.value, 'checkout')
  assert.deepEqual(matched?.params, { '*': 'payment/card' })
})

test('a wildcard matches its own prefix with nothing after it', () => {
  assert.deepEqual(table().match('/checkout')?.params, { '*': '' })
})

test('a trailing slash is not a different route', () => {
  assert.equal(table().match('/cart/')?.value, 'cart')
  assert.equal(table().match('/product/rice/')?.params.sku, 'rice')
})

test('a query string is not part of the path', () => {
  assert.equal(table().match('/cart?sort=price')?.value, 'cart')
})

test('a full URL and a bare path match the same way', () => {
  assert.equal(table().match(new URL('https://example.test/cart?x=1'))?.value, 'cart')
  assert.equal(table().match('https://example.test/cart')?.value, 'cart')
})

test('nothing matched is null, not a guess', () => {
  assert.equal(table().match('/nope'), null)
  assert.equal(table().match('/product/a/b'), null)
})

test('a param is percent-decoded, because it becomes a key component', () => {
  assert.equal(table().match('/product/rice%205kg')?.params.sku, 'rice 5kg')
})

test('an invalid escape fails the match rather than reaching the key', () => {
  assert.equal(table().match('/product/%E0%A4%A'), null)
})

test('two patterns matching the same paths are a conflict, whatever the params are called', () => {
  assert.throws(
    () =>
      createRouter([
        { pattern: '/product/:sku', value: 1 },
        { pattern: '/product/:id', value: 2 },
      ]),
    /E_ROUTE_CONFLICT/,
  )
})

test('a malformed pattern is refused at construction', () => {
  assert.throws(() => createRouter([{ pattern: 'cart', value: 1 }]), /E_BAD_PATTERN.*must start/s)
  assert.throws(() => createRouter([{ pattern: '/a/*/b', value: 1 }]), /E_BAD_PATTERN.*last segment/s)
  assert.throws(() => createRouter([{ pattern: '/a/:x/:x', value: 1 }]), /E_BAD_PATTERN.*twice/s)
  assert.throws(() => createRouter([{ pattern: '/a/:', value: 1 }]), /E_BAD_PATTERN.*usable param/s)
})

test('colliding patterns are tried most specific first', () => {
  // Only the relative order of patterns that could match one path is a guarantee.
  const order = table().patterns
  const before = (a: string, b: string) => order.indexOf(a) < order.indexOf(b)
  assert.ok(before('/product/new', '/product/:sku'))
  assert.ok(before('/product/:sku', '/checkout/*'))
  assert.equal(order.length, 6)
  assert.equal(order.at(-1), '/', 'the root can only match one path, so it is tried last')
})
