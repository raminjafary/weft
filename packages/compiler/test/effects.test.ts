import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cacheClassOf, explain, flagAxes, keyComponents, requiresTtl, varyOn } from '@weft/ir'
import { compileSource } from '../src/compile.ts'
import { CompileError } from '../src/errors.ts'

const PRELUDE = "import { fragment } from '@weft/core'\nimport { newCart } from './flags.ts'\n"

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
