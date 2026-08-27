import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bindDerived, evaluate } from '../src/derived.ts'
import { signal } from '../src/signal.ts'
import type { ClientDerived } from '../src/template.ts'

const read = (id: string) => ({ a: 3, b: 4 })[id as 'a' | 'b']

test('the evaluator walks the encoded expression the server sent', () => {
  assert.equal(evaluate({ k: 'lit', v: 7 }, read), 7)
  assert.equal(evaluate({ k: 'ref', id: 'a' }, read), 3)
  assert.equal(evaluate({ k: 'un', op: '-', a: { k: 'ref', id: 'a' } }, read), -3)
  assert.equal(evaluate({ k: 'bin', op: '*', a: { k: 'ref', id: 'a' }, b: { k: 'ref', id: 'b' } }, read), 12)
})

test('a binding the client does not hold reads as null, not as a throw', () => {
  assert.equal(
    evaluate({ k: 'ref', id: 'nope' }, () => undefined),
    null,
  )
})

test('a derived value over a signal tracks it', () => {
  const n = signal(2)
  const decls: ClientDerived[] = [
    { id: 'd0', expr: { k: 'bin', op: '*', a: { k: 'ref', id: 'n' }, b: { k: 'lit', v: 2 } } },
  ]
  const sources = bindDerived(decls, { n })
  const seen: unknown[] = []
  sources.d0?.subscribe(() => seen.push(sources.d0?.()))

  assert.equal(sources.d0?.(), 4)
  n.set(5)
  assert.deepEqual(seen, [10])
})

test('one derived value may read another declared before it', () => {
  const n = signal(1)
  const decls: ClientDerived[] = [
    { id: 'd0', expr: { k: 'bin', op: '+', a: { k: 'ref', id: 'n' }, b: { k: 'lit', v: 1 } } },
    { id: 'd1', expr: { k: 'bin', op: '*', a: { k: 'ref', id: 'd0' }, b: { k: 'lit', v: 10 } } },
  ]
  const sources = bindDerived(decls, { n })
  assert.equal(sources.d1?.(), 20)
  n.set(4)
  assert.equal(sources.d1?.(), 50)
})

test('a derived value the client cannot compute is left to the server', () => {
  const decls: ClientDerived[] = [
    { id: 'd0', expr: { k: 'bin', op: '*', a: { k: 'ref', id: 'price' }, b: { k: 'lit', v: 2 } } },
  ]
  const sources = bindDerived(decls, { n: signal(1) })
  assert.equal(sources.d0, undefined, 'price is a prop, so d0 is not the client to compute')
})

test('a derived value that never moves notifies nobody', () => {
  const n = signal(1)
  const decls: ClientDerived[] = [
    { id: 'd0', expr: { k: 'bin', op: '>', a: { k: 'ref', id: 'n' }, b: { k: 'lit', v: 0 } } },
  ]
  const sources = bindDerived(decls, { n })
  let runs = 0
  sources.d0?.subscribe(() => runs++)
  n.set(2)
  assert.equal(runs, 0, 'still true, so the DOM is not written')
  n.set(-1)
  assert.equal(runs, 1)
})

const exploding = (id: string) => {
  if (id === 'boom') throw new Error('the untaken arm was evaluated')
  return id === 'on' ? true : 'taken'
}

test('a conditional value is evaluated, and lazily in its arms', () => {
  assert.equal(
    evaluate(
      { k: 'cond', a: { k: 'ref', id: 'on' }, b: { k: 'lit', v: 'yes' }, c: { k: 'ref', id: 'boom' } },
      exploding,
    ),
    'yes',
  )
})

test('a conditional over a signal is reactive, including when only its test reads one', () => {
  const on = signal(false)
  const decls: ClientDerived[] = [
    {
      id: 'd0',
      expr: { k: 'cond', a: { k: 'ref', id: 'on' }, b: { k: 'lit', v: 'live' }, c: { k: 'lit', v: 'idle' } },
    },
  ]
  const sources = bindDerived(decls, { on })
  // Neither arm reads the signal; which arm is taken does. A `reaches` that only looked at the arms
  // would leave this value bound to nothing and the server's render would stand for ever.
  assert.equal(sources.d0?.(), 'idle')
  on.set(true)
  assert.equal(sources.d0?.(), 'live')
})

test('a `+` chain concatenates when a side is a string, which is what a template literal lowers to', () => {
  const id = signal('7')
  const decls: ClientDerived[] = [
    { id: 'd0', expr: { k: 'bin', op: '+', a: { k: 'lit', v: 'row-' }, b: { k: 'ref', id: 'id' } } },
  ]
  const sources = bindDerived(decls, { id })
  assert.equal(sources.d0?.(), 'row-7')
  id.set('9')
  assert.equal(sources.d0?.(), 'row-9')
})
