import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cacheClassOf, explain, flagAxes, keyComponents, requiresTtl, varyOn } from '@weftjs/ir'
import { compileSource, loaderReads } from '../src/compile.ts'
import { CompileError } from '../src/errors.ts'

const PRELUDE = "import { fragment } from '@weftjs/core'\nimport { newCart } from './flags.ts'\n"

async function effects(body: string) {
  const out = await compileSource(PRELUDE + body, 'test.tsx')
  const entry = out.fragments[0]?.entry
  assert.ok(entry, 'nothing compiled')
  return entry.effects
}

async function rejects(body: string, code: string): Promise<void> {
  await assert.rejects(
    () => compileSource(PRELUDE + body, 'test.tsx'),
    (error: unknown) => {
      assert.ok(error instanceof CompileError, `expected a CompileError, got ${String(error)}`)
      assert.equal(error.code, code, error.message)
      return true
    },
  )
}

test('a fragment that reads nothing is static, without being told', async () => {
  const set = await effects('export default fragment(() => <p>Groceries, delivered.</p>)')
  assert.deepEqual(set.reads, [])
  assert.equal(set.residency, 'either')
  assert.equal(cacheClassOf(set), 'static')
})

test('the read surface taints exactly as the design specifies', async () => {
  const set = await effects(`export default fragment(async (ctx) => {
    const currency = ctx.cookie('currency')
    const agent = ctx.header('user-agent')
    const region = ctx.param('region')
    const page = ctx.query('page')
    const locale = ctx.locale()
    const device = ctx.device()
    const layout = await ctx.flag(newCart)
    return <p>{currency}{agent}{region}{page}{locale}{device}{layout}</p>
  })`)
  assert.deepEqual(set.reads, [
    'cookie:currency',
    'device',
    'flag:new-cart',
    'header:user-agent',
    'locale',
    'route:page',
    'route:region',
  ])
  assert.equal(set.residency, 'server')
})

test('one identity read makes a fragment private, whatever else it reads', async () => {
  const set = await effects(`export default fragment(async (ctx) => {
    const currency = ctx.cookie('currency')
    const user = await ctx.user()
    return <p>{user}{currency}</p>
  })`)
  assert.equal(cacheClassOf(set), 'private')
  assert.deepEqual(varyOn(set), ['Cookie'])
})

test('a flag is an axis, not a key component', async () => {
  const set = await effects(`export default fragment(async (ctx) => {
    const layout = await ctx.flag(newCart)
    const currency = ctx.cookie('currency')
    return <p>{layout}{currency}</p>
  })`)
  assert.deepEqual(flagAxes(set), ['new-cart'])
  assert.deepEqual(keyComponents(set), ['cookie:currency'])
})

test('reading the clock forces a TTL and stays out of the key', async () => {
  const set = await effects(`export default fragment((ctx) => {
    const at = ctx.now()
    return <p>{at}</p>
  })`)
  assert.equal(requiresTtl(set), true)
  assert.deepEqual(keyComponents(set), [])
  assert.match(explain(set), /needs a TTL/)
})

test('the escape hatch is uncacheable and visible, not silent', async () => {
  const set = await effects(`export default fragment((ctx) => {
    const value = ctx.raw(() => 1)
    return <p>{value}</p>
  })`)
  assert.deepEqual(set.reads, ['opaque'])
  assert.equal(cacheClassOf(set), 'private')
})

test('a header read adds the header itself to Vary, not just Cookie', async () => {
  const set = await effects(`export default fragment((ctx) => {
    const agent = ctx.header('accept-encoding')
    return <p>{agent}</p>
  })`)
  assert.deepEqual(varyOn(set), ['Accept-Encoding'])
})

test('reads are sorted, so a cache key cannot depend on authoring order', async () => {
  const a = await effects(`export default fragment((ctx) => {
    const x = ctx.cookie('a'); const y = ctx.header('b'); return <p>{x}{y}</p>
  })`)
  const b = await effects(`export default fragment((ctx) => {
    const y = ctx.header('b'); const x = ctx.cookie('a'); return <p>{y}{x}</p>
  })`)
  assert.deepEqual(a.reads, b.reads)
})

test('an untracked ambient read is a build error, not a lint note', async () => {
  await rejects('export default fragment(() => <p>{process.env.MODE}</p>)', 'E_UNTRACKED_EFFECT')
  await rejects(
    'export default fragment(() => { const t = Date.now(); return <p>{t}</p> })',
    'E_UNTRACKED_EFFECT',
  )
  await rejects(
    'export default fragment(() => { const t = new Date(); return <p>{t}</p> })',
    'E_UNTRACKED_EFFECT',
  )
  await rejects(
    'export default fragment(() => { const t = Math.random(); return <p>{t}</p> })',
    'E_UNTRACKED_EFFECT',
  )
  await rejects(
    'export default fragment(() => { const t = window.location; return <p>{t}</p> })',
    'E_UNTRACKED_EFFECT',
  )
})

test('the error names the alternative, because the point is to redirect the read', async () => {
  await assert.rejects(
    () =>
      compileSource(
        `${PRELUDE}export default fragment(() => { const t = Date.now(); return <p>{t}</p> })`,
        't.tsx',
      ),
    (error: unknown) => {
      assert.match((error as CompileError).message, /ctx\.now\(\)/)
      return true
    },
  )
})

test('a read the compiler does not know is refused rather than ignored', async () => {
  await rejects(
    'export default fragment((ctx) => { const x = ctx.geolocation(); return <p>{x}</p> })',
    'E_UNKNOWN_EFFECT',
  )
})

test('a taint has to be statically known, or the key cannot be derived', async () => {
  await rejects(
    "export default fragment((ctx) => { const k = 'a' + 'b'; const x = ctx.cookie(k); return <p>{x}</p> })",
    'E_DYNAMIC_TAINT',
  )
})

test('a render cannot touch the envelope', async () => {
  await rejects(
    "export default fragment((ctx) => { ctx.setCookie('a', 'b'); return <p>x</p> })",
    'E_ENVELOPE_IN_RENDER',
  )
})

test('a context read has to be named in the body, not inlined into markup', async () => {
  await rejects('export default fragment((ctx) => <p>{ctx.locale()}</p>)', 'E_CTX_IN_MARKUP')
})

test('effects are part of the content address, so a new read moves the version', async () => {
  const plain = await compileSource(`${PRELUDE}export default fragment(() => <p>x</p>)`, 't.tsx')
  const reading = await compileSource(
    `${PRELUDE}export default fragment((ctx) => { const c = ctx.cookie('a'); return <p>x</p> })`,
    't.tsx',
  )
  assert.notEqual(plain.fragments[0]?.entry.version, reading.fragments[0]?.entry.version)
})

/**
 * A route's loader, which is where an application actually reads the request.
 *
 * The compiler inferred a *fragment's* reads and that was the whole of what a cache key contained.
 * A route's loader lives in a `.data.ts` the compiler never read, so `ctx.query('rows')` there
 * tainted nothing — the key could not contain it, and whichever value rendered first answered for
 * every other one until the entry expired. The demo served `?rows=200` the twenty-row render for
 * thirty seconds and then five minutes of stale-while-revalidate, and nothing in the framework
 * said a word: `weft build` reported the fragment's reads and `weft verify --probe` was silent.
 */
const DATA = "import { defineRoute } from '@weftjs/core'\n"

test('a read in a route loader is a key component', () => {
  assert.deepEqual(
    loaderReads(
      'x.data.ts',
      DATA +
        `export default defineRoute({
           slots: { body: { load: (ctx) => ({ rows: Number(ctx.query('rows') ?? 120) }) } },
         })`,
    ),
    ['route:rows'],
  )
})

test('every read the file performs, whichever function performed it', () => {
  assert.deepEqual(
    loaderReads(
      'x.data.ts',
      DATA +
        `export default defineRoute({
           head: (ctx) => ({ title: ctx.param('slug') }),
           slots: {
             body: { load: (c) => ({ n: c.query('page'), who: c.cookie('currency') }) },
             side: { html: (_ctx) => String(_ctx.locale()) },
           },
         })`,
    ),
    ['cookie:currency', 'locale', 'route:page', 'route:slug'],
  )
})

/**
 * The idiom the first attempt refused, and the reason one level of indirection is resolved.
 *
 * `const num = (ctx, key, fallback) => Number(ctx.query(key) ?? fallback)` is how a loader with
 * three sliders is written, and the read inside it names a parameter rather than a string. The
 * *call sites* name it, every one of them, a few lines down — so refusing this would be refusing
 * the idiom rather than the ambiguity. The demo's dashboard is exactly this shape.
 */
test('a read whose name arrives as a helper parameter is resolved through the call sites', () => {
  assert.deepEqual(
    loaderReads(
      'x.data.ts',
      DATA +
        `const num = (ctx, key, fallback) => Number(ctx.query(key) ?? fallback)
         export default defineRoute({
           slots: { body: { load: (ctx) => ({ slow: num(ctx, 'slow', 600), cpu: num(ctx, 'budget', 200) }) } },
         })`,
    ),
    ['route:budget', 'route:slow'],
  )
})

/**
 * And two levels are refused, because a chain of two is a key nobody can follow either.
 *
 * The refusal is the point. Returning an empty set here would read as "this loader reads nothing"
 * and put back exactly the wrong key this whole path exists to stop.
 */
test('a name the call sites do not give either is refused rather than guessed', () => {
  assert.throws(
    () =>
      loaderReads(
        'x.data.ts',
        DATA +
          `const num = (ctx, key) => ctx.query(key)
           const pick = (ctx, k) => num(ctx, k)
           export default defineRoute({
             slots: { body: { load: (ctx) => ({ n: pick(ctx, 'rows') }) } },
           })`,
      ),
    (error: unknown) => {
      assert.ok(error instanceof CompileError)
      assert.equal(error.code, 'E_DYNAMIC_TAINT', error.message)
      return true
    },
  )
})

/**
 * A loader's context is wider than a fragment's, and running the fragment walk here would refuse
 * every application that has one. `ctx.data(...)` is not a read this collects; it is also not an
 * error, because it is not this analysis's business.
 */
test('a loader may call things a fragment may not, and they are stepped over', () => {
  assert.deepEqual(
    loaderReads(
      'x.data.ts',
      DATA +
        `export default defineRoute({
           slots: {
             body: {
               load: async (ctx) => {
                 const items = await ctx.data({ name: 'feed.rows', tags: ['feed'] }, async () => [])
                 return { items, rows: ctx.query('rows'), at: ctx.now() }
               },
             },
           },
         })`,
    ),
    ['route:rows', 'time'],
  )
})

test('a declaration that reads nothing taints nothing', () => {
  assert.deepEqual(
    loaderReads('x.data.ts', DATA + `export default defineRoute({ slots: { body: { html: () => 'hi' } } })`),
    [],
  )
})
