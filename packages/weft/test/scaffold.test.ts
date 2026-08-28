import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { scaffold } from '../src/scaffold.ts'

/**
 * What `npm create weft` leaves on disk, asserted on the output rather than on the templates.
 *
 * The templates are two directories of files and it is easy to believe they say what they should.
 * These are the three things a scaffolded application was missing that its own tooling then
 * produced: a build artefact nobody ignored, a checker nobody could run, and — for the app
 * template — a `weft site` output directory that would have been committed the first time anybody
 * ran the command the README suggests.
 */
let dir = ''

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'weft-scaffold-'))
})

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

async function made(template: 'app' | 'minimal', name: string) {
  const target = join(dir, name)
  const created = await scaffold({ directory: target, name, template })
  const pkg = JSON.parse(await readFile(join(target, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>
    devDependencies: Record<string, string>
  }
  const ignored = (await readFile(join(target, '.gitignore'), 'utf8')).split('\n').filter(Boolean)
  return { created, pkg, ignored }
}

for (const template of ['app', 'minimal'] as const) {
  /**
   * The scaffold ships TypeScript and a `tsconfig.json`, so it should ship the one command that
   * uses them. Without it a `tsc --noEmit` that passes is a thing the author has to know to run.
   */
  test(`the ${template} template can typecheck itself`, async () => {
    const { pkg } = await made(template, `${template}-typecheck`)
    assert.equal(pkg.scripts.typecheck, 'tsc -p tsconfig.json --noEmit')
    assert.ok(pkg.devDependencies.typescript, 'and the checker it runs is a dependency of the app')
  })

  /**
   * `.weft/` was ignored and `.site/` was not — and `.site` is the directory the `weft site`
   * help text names as its default. A generated site is a build output whichever command wrote it.
   */
  test(`the ${template} template ignores what its own commands write`, async () => {
    const { ignored } = await made(template, `${template}-ignore`)
    for (const entry of ['node_modules/', '.weft/', '.site/']) {
      assert.ok(ignored.includes(entry), `${entry} is written by a command and belongs in .gitignore`)
    }
  })
}

test('the app template scaffolds a page, a fragment, an intent and a slot', async () => {
  const { created } = await made('app', 'shape')
  const files = created.files.map((f) => f.replace(/\\/g, '/'))
  for (const expected of [
    'app/routes/index.tsx',
    'app/routes/index.data.ts',
    'app/intents/counter.ts',
    'app/fragments/card.tsx',
    'app/slots/footer.tsx',
    'weft.config.ts',
  ]) {
    assert.ok(
      files.some((f) => f.endsWith(expected)),
      `${expected} is what the scaffold is for: every convention with one real example`,
    )
  }
})

test('a template that does not exist is refused by name', async () => {
  await assert.rejects(
    scaffold({ directory: join(dir, 'nope'), name: 'nope', template: 'nonsense' as 'app' }),
    /E_NO_TEMPLATE/,
  )
})
