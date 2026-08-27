import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import { compileFile, compileFiles } from '../src/compile.ts'
import { createTypeOracle } from '../src/types.ts'

let dir = ''

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'weft-types-'))
  // The checker is project-based, so a fixture needs a project to belong to — the same
  // thing a real application has.
  const ambient = fileURLToPath(new URL('../types/weft.d.ts', import.meta.url))
  await writeFile(
    join(dir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'es2023',
          lib: ['es2023', 'dom'],
          jsx: 'preserve',
          module: 'nodenext',
          moduleResolution: 'nodenext',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          allowImportingTsExtensions: true,
          types: [],
        },
        include: ['*.tsx', ambient],
      },
      null,
      2,
    ),
  )
})

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

async function fixture(name: string, body: string): Promise<string> {
  const file = join(dir, `${name}.tsx`)
  await writeFile(file, `import { fragment, signal, raw } from '@weftjs/core'\n${body}\n`)
  return file
}

async function escapesOf(file: string, options?: { types?: boolean }): Promise<string[]> {
  const { modules } = await compileFiles([file], { root: dir, ...options })
  const entry = modules[0]?.fragments[0]?.entry
  assert.ok(entry, 'nothing compiled')
  return entry.holes.map((h) => h.escape)
}

test('a numeric prop needs no escaping, and a string one does', async () => {
  const file = await fixture(
    'kinds',
    'export default fragment(({ n, s }: { n: number; s: string }) => <p data-n={n}>{s}</p>)',
  )
  assert.deepEqual(await escapesOf(file), ['proven-safe', 'escape'])
})

test('a boolean is safe, and a union with a string is not', async () => {
  const file = await fixture(
    'union',
    'export default fragment(({ b, u }: { b: boolean; u: number | string }) => <p title={b}>{u}</p>)',
  )
  assert.deepEqual(await escapesOf(file), ['proven-safe', 'escape'])
})

test('an untyped prop escapes, because any is not a proof', async () => {
  const file = await fixture('untyped', 'export default fragment(({ v }: { v: unknown }) => <p>{v}</p>)')
  assert.deepEqual(await escapesOf(file), ['escape'])
})

test('without type information the same template escapes everything', async () => {
  const file = await fixture('notypes', 'export default fragment(({ n }: { n: number }) => <p>{n}</p>)')
  assert.deepEqual(await escapesOf(file, { types: true }), ['proven-safe'])
  assert.deepEqual(await escapesOf(file, { types: false }), ['escape'])
  assert.deepEqual(
    (await compileFile(file, { root: dir })).fragments[0]?.entry.holes.map((h) => h.escape),
    ['escape'],
  )
})

test('a signal carries its type through the read', async () => {
  const numeric = await fixture(
    'signal-number',
    'export default fragment(() => { const n = signal(1); return <p>{n()}</p> })',
  )
  const textual = await fixture(
    'signal-string',
    'export default fragment(() => { const s = signal("x"); return <p>{s()}</p> })',
  )
  assert.deepEqual(await escapesOf(numeric), ['proven-safe'])
  assert.deepEqual(await escapesOf(textual), ['escape'])
})

test('raw() outranks the type, and keeps its provenance', async () => {
  const file = await fixture('raw', 'export default fragment(({ h }: { h: string }) => <p>{raw(h)}</p>)')
  const { modules } = await compileFiles([file], { root: dir })
  const hole = modules[0]?.fragments[0]?.entry.holes[0]
  assert.equal(hole?.escape, 'trusted-raw')
  assert.equal(hole?.provenance, 'h')
})

test('a type error is reported and does not stop the template lowering', async () => {
  // A type error elsewhere in the module: the template itself is lowerable.
  const file = await fixture(
    'broken',
    'const wrong: number = "not a number"\nexport default fragment(({ n }: { n: number }) => <p>{n}</p>)',
  )
  const { modules, diagnostics } = await compileFiles([file], { root: dir })
  assert.equal(modules[0]?.fragments.length, 1, 'the template should still lower')
  assert.equal(diagnostics.length >= 1, true, 'the type error should be reported')
})

test('the oracle answers by exact span', async () => {
  const file = await fixture('span', 'export default fragment(({ n }: { n: number }) => <p>{n}</p>)')
  const oracle = createTypeOracle([file], dir)
  const source = `import { fragment, signal, raw } from '@weftjs/core'\nexport default fragment(({ n }: { n: number }) => <p>{n}</p>)\n`
  const start = source.lastIndexOf('{n}') + 1
  assert.equal(oracle.kindAt(file, start, start + 1), 'number')
  assert.equal(oracle.kindAt(file, 0, 3), 'other')
})
