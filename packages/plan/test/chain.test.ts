import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { EffectSet } from '@weft/ir'
import { assertPlan, plan, shell, slot, validatePlan, type SlotFacts } from '../src/index.ts'

function effects(reads: string[]): EffectSet {
  return { reads: [...reads].sort(), writes: [], envelope: [], residency: reads.length ? 'server' : 'either' }
}

function facts(id: string, fillable: string[], reads: string[] = []): SlotFacts {
  return { id, version: `v-${id}`, effects: effects(reads), forms: ['html'], fillable }
}

const OUTER = 'layout.tsx#default'
const INNER = 'routes/docs/layout.tsx#default'

function chained(
  outerHoles: string[],
  innerHoles: string[],
  slots: string[],
  reads: { outer?: string[]; inner?: string[] } = {},
) {
  return {
    plan: plan('/docs', [
      shell(OUTER, [{ at: 'body', fragment: INNER }]),
      ...slots.map((name) => slot(name)),
    ]),
    facts: {
      [OUTER]: facts(OUTER, outerHoles, reads.outer ?? []),
      [INNER]: facts(INNER, innerHoles, reads.inner ?? []),
      // A slot's fragment defaults to its own name, so each one needs facts of its own.
      ...Object.fromEntries(slots.map((name) => [name, facts(name, [])])),
    },
  }
}

test('a shell entry carries its chain, and a plan with no chain is unchanged', () => {
  const flat = plan('/', [shell(OUTER)])
  assert.equal(flat.shell, OUTER)
  assert.equal(flat.shellChain, undefined)

  const nested = plan('/docs', [shell(OUTER, [{ at: 'body', fragment: INNER }])])
  assert.deepEqual(nested.shellChain, [{ at: 'body', fragment: INNER }])
})

test('the boundaries of a chain are the union of its layers, minus the hole each link fills', () => {
  const { plan: p, facts: f } = chained(
    ['panel', 'body', 'readout'],
    ['toc', 'body'],
    ['panel', 'toc', 'body', 'readout'],
  )
  assertPlan(p, { facts: f })
})

test('a slot naming the hole a link fills is refused: that hole is where the next layout goes', () => {
  // `body` belongs to the *inner* layout here. Declaring the outer one's `panel` twice cannot be
  // expressed, so the case that matters is a slot naming a hole no layer leaves any more.
  const { plan: p, facts: f } = chained(
    ['panel', 'body'],
    ['toc', 'article'],
    ['panel', 'toc', 'article', 'body'],
  )
  const diagnostics = validatePlan(p, { facts: f })
  assert.ok(
    diagnostics.errors.some((issue) => issue.code === 'E_SLOT_NOT_IN_SHELL' && issue.slot === 'body'),
    JSON.stringify(diagnostics.errors),
  )
})

test('a hole in either layer that nothing fills is named', () => {
  const { plan: p, facts: f } = chained(['panel', 'body'], ['toc', 'body'], ['panel', 'body'])
  const diagnostics = validatePlan(p, { facts: f })
  assert.ok(
    diagnostics.errors.some(
      (issue) => issue.code === 'E_SHELL_HOLE_UNFILLED' && issue.message.includes('toc'),
    ),
    JSON.stringify(diagnostics.errors),
  )
})

test('a link with nowhere to go is refused by name, with what the enclosing layout does leave', () => {
  const { plan: p, facts: f } = chained(['panel', 'main'], ['toc', 'body'], ['panel', 'main', 'toc', 'body'])
  const diagnostics = validatePlan(p, { facts: f })
  const issue = diagnostics.errors.find((e) => e.code === 'E_SHELL_LINK_UNPLACED')
  assert.ok(issue, JSON.stringify(diagnostics.errors))
  assert.match(issue.message, /does not leave \(it leaves main, panel\)/)
})

test('a nested layout the compiler did not produce is refused, not skipped', () => {
  const p = plan('/docs', [shell(OUTER, [{ at: 'body', fragment: 'ghost' }]), slot('panel')])
  const diagnostics = validatePlan(p, {
    facts: { [OUTER]: facts(OUTER, ['panel', 'body']), panel: facts('panel', []) },
  })
  assert.ok(
    diagnostics.errors.some((e) => e.code === 'E_NO_SUCH_FRAGMENT' && e.message.includes('ghost')),
    JSON.stringify(diagnostics.errors),
  )
})

/**
 * The property the whole chain exists to preserve: a document is what all of its layers read.
 *
 * A nested layout reading identity makes the page private. Checking the outermost layer alone
 * would advertise it as shareable on the strength of a file that is only part of it.
 */
test('a nested layout that reads identity makes the document private', () => {
  const { facts: f } = chained(['panel', 'body'], ['body'], ['panel', 'body'], {
    inner: ['identity'],
  })
  const withPolicy = plan(
    '/docs',
    [shell(OUTER, [{ at: 'body', fragment: INNER }]), slot('panel'), slot('body')],
    {
      cache: { class: 'public', ttl: '1h' },
    },
  )
  const diagnostics = validatePlan(withPolicy, { facts: f })
  assert.ok(
    diagnostics.errors.some((e) => e.message.includes('the shell')),
    JSON.stringify(diagnostics.errors),
  )
})
