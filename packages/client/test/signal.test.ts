import assert from 'node:assert/strict'
import { test } from 'node:test'
import { batch, computed, effect, signal, untrack } from '../src/signal.ts'

test('a read returns the value and a write notifies subscribers', () => {
  const count = signal(1)
  const seen: number[] = []
  count.subscribe(() => seen.push(count()))
  count.set(2)
  count.set(3)
  assert.equal(count(), 3)
  assert.deepEqual(seen, [2, 3])
})

test('writing the same value notifies nobody', () => {
  const count = signal(1)
  let runs = 0
  count.subscribe(() => runs++)
  count.set(1)
  assert.equal(runs, 0)
})

test('a batch collapses two writes into one notification', () => {
  const count = signal(0)
  let runs = 0
  count.subscribe(() => runs++)
  batch(() => {
    count.set(1)
    count.set(2)
  })
  assert.equal(runs, 1)
  assert.equal(count(), 2)
})

test('a batch that throws still flushes what it changed', () => {
  const count = signal(0)
  let runs = 0
  count.subscribe(() => runs++)
  assert.throws(() =>
    batch(() => {
      count.set(1)
      throw new Error('boom')
    }),
  )
  assert.equal(runs, 1)
})

test('unsubscribing stops the writes', () => {
  const count = signal(0)
  let runs = 0
  const stop = count.subscribe(() => runs++)
  count.set(1)
  stop()
  count.set(2)
  assert.equal(runs, 1)
})

test('nested batches flush once, at the outermost exit', () => {
  const count = signal(0)
  const runs: number[] = []
  count.subscribe(() => runs.push(count()))
  batch(() => {
    count.set(1)
    batch(() => count.set(2))
    assert.deepEqual(runs, [], 'the inner batch must not flush')
  })
  assert.deepEqual(runs, [2])
})

test('a computed is lazy: it does not run until something reads it', () => {
  const n = signal(2)
  let runs = 0
  const double = computed(() => {
    runs++
    return n() * 2
  })
  assert.equal(runs, 0)
  assert.equal(double(), 4)
  assert.equal(runs, 1)
})

test('a computed reads once per change, not once per read', () => {
  const n = signal(2)
  let runs = 0
  const double = computed(() => {
    runs++
    return n() * 2
  })
  double()
  double()
  double()
  assert.equal(runs, 1)
  n.set(3)
  assert.equal(double(), 6)
  assert.equal(runs, 2)
})

test('a diamond notifies the effect once, not once per path', () => {
  const n = signal(1)
  const a = computed(() => n() + 1)
  const b = computed(() => n() * 2)
  let runs = 0
  effect(() => {
    a()
    b()
    runs++
  })
  assert.equal(runs, 1)
  n.set(2)
  assert.equal(runs, 2, 'one write reaching two paths is still one run')
})

test('a computed that lands on the same value stops the propagation', () => {
  const n = signal(1)
  const parity = computed(() => n() % 2)
  let runs = 0
  parity.subscribe(() => runs++)
  n.set(3)
  assert.equal(parity(), 1)
  assert.equal(runs, 0, 'the value did not move, so nothing downstream ran')
  n.set(4)
  assert.equal(runs, 1)
})

test('an effect drops the dependencies its last run did not read', () => {
  const on = signal(true)
  const a = signal('a')
  const b = signal('b')
  const seen: string[] = []
  effect(() => seen.push(on() ? a() : b()))
  assert.deepEqual(seen, ['a'])

  b.set('b2')
  assert.deepEqual(seen, ['a'], 'b was never read, so it is not a dependency')

  on.set(false)
  assert.deepEqual(seen, ['a', 'b2'])

  a.set('a2')
  assert.deepEqual(seen, ['a', 'b2'], 'a was dropped when the branch flipped')

  b.set('b3')
  assert.deepEqual(seen, ['a', 'b2', 'b3'])
})

test('disposing an effect unlinks it', () => {
  const n = signal(0)
  let runs = 0
  const stop = effect(() => {
    n()
    runs++
  })
  n.set(1)
  assert.equal(runs, 2)
  stop()
  n.set(2)
  assert.equal(runs, 2)
})

test('a batch collapses two writes across a computed into one run', () => {
  const n = signal(0)
  const double = computed(() => n() * 2)
  const seen: number[] = []
  double.subscribe(() => seen.push(double()))
  batch(() => {
    n.set(1)
    n.set(2)
  })
  assert.deepEqual(seen, [4])
})

test('two writes that cancel out inside a batch run nothing', () => {
  const n = signal(1)
  const double = computed(() => n() * 2)
  let runs = 0
  double.subscribe(() => runs++)
  batch(() => {
    n.set(2)
    n.set(1)
  })
  assert.equal(runs, 0)
})

test('untrack reads without becoming a dependency', () => {
  const a = signal(1)
  const b = signal(1)
  let runs = 0
  effect(() => {
    a()
    untrack(() => b())
    runs++
  })
  b.set(2)
  assert.equal(runs, 1)
  a.set(2)
  assert.equal(runs, 2)
})

test('a chain of computeds pulls only as far as the change reaches', () => {
  const n = signal(1)
  let midRuns = 0
  let topRuns = 0
  const mid = computed(() => {
    midRuns++
    return n() > 0
  })
  const top = computed(() => {
    topRuns++
    return mid() ? 'yes' : 'no'
  })
  let effectRuns = 0
  effect(() => {
    top()
    effectRuns++
  })
  assert.deepEqual([midRuns, topRuns, effectRuns], [1, 1, 1])

  n.set(2)
  assert.equal(midRuns, 2, 'mid recomputes because n moved')
  assert.equal(topRuns, 1, 'mid returned the same boolean, so top never reran')
  assert.equal(effectRuns, 1)

  n.set(-1)
  assert.deepEqual([midRuns, topRuns, effectRuns], [3, 2, 2])
})

test('an effect that writes is flushed inside the same turn', () => {
  const a = signal(0)
  const b = signal(0)
  const seen: number[] = []
  effect(() => b.set(a() + 1))
  effect(() => seen.push(b()))
  a.set(5)
  assert.deepEqual(seen, [1, 6])
})

test('a computed nobody watches any more goes cold and recomputes on the next read', () => {
  const n = signal(1)
  let runs = 0
  const double = computed(() => {
    runs++
    return n() * 2
  })
  const stop = double.subscribe(() => {})
  assert.equal(runs, 1)
  stop()
  n.set(2)
  assert.equal(double(), 4)
  assert.equal(runs, 2)
})
