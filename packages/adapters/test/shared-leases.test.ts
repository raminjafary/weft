import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { memoryStore } from '../src/memory-store.ts'
import { sharedLeases } from '../src/shared-leases.ts'

/**
 * A lease more than one process agrees about, and the reason it matters.
 *
 * Replay protection is exactly as strong as the store's lease: a nonce is spent by taking one nobody
 * releases. Every store this framework shipped was process-scoped, so `W_REPLAY_PROCESS_LOCAL` was a
 * warning no deployment could act on — and a warning nobody can act on teaches people to ignore
 * warnings.
 *
 * The assertion that matters here is the one that needs a **second process**. Anything asserted
 * inside one process is asserted about a Map, and a Map has never been the thing in question.
 */
const run = promisify(execFile)
const HERE = fileURLToPath(new URL('../src/', import.meta.url))

const dirs: string[] = []
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'weft-lease-'))
  dirs.push(dir)
  return dir
}

/**
 * Takes a lease in a child process and prints whether it got one.
 *
 * A child rather than a worker, because a worker shares the parent's heap and a heap is exactly what
 * this is not using — two isolates in one process would agree about a Map, which is the arrangement
 * being replaced rather than the one being tested.
 */
async function inAnotherProcess(dir: string, key: string): Promise<boolean> {
  const script = `
    import { memoryStore } from '${HERE}memory-store.ts'
    import { sharedLeases } from '${HERE}shared-leases.ts'
    const store = sharedLeases(memoryStore(), { dir: ${JSON.stringify(dir)} })
    const lease = await store.lease(${JSON.stringify(key)}, 60_000)
    process.stdout.write(lease ? 'took' : 'held')
  `
  const { stdout } = await run(process.execPath, ['--input-type=module', '--eval', script])
  return stdout.trim() === 'took'
}

test('a lease taken in one process is held as far as another process is concerned', async () => {
  const dir = await scratch()
  const store = sharedLeases(memoryStore(), { dir })

  const mine = await store.lease('weft:intent-nonce:n-1', 60_000)
  assert.ok(mine, 'this process took it')
  assert.equal(
    await inAnotherProcess(dir, 'weft:intent-nonce:n-1'),
    false,
    'and a genuinely separate process cannot: that is what makes a spent nonce spent',
  )
})

test('a different nonce is a different lease, so one spent token does not refuse every other', async () => {
  const dir = await scratch()
  const store = sharedLeases(memoryStore(), { dir })
  assert.ok(await store.lease('weft:intent-nonce:n-1', 60_000))
  assert.equal(await inAnotherProcess(dir, 'weft:intent-nonce:n-2'), true)
})

test('the process that takes it first wins, and it does not matter which one that is', async () => {
  const dir = await scratch()
  // Both in children, so neither is privileged by being the one holding the directory handle.
  const [first, second] = await Promise.all([
    inAnotherProcess(dir, 'weft:intent-nonce:race'),
    inAnotherProcess(dir, 'weft:intent-nonce:race'),
  ])
  assert.deepEqual([first, second].filter(Boolean).length, 1, 'exactly one of two concurrent takers')
})

test('releasing it lets the next caller have it, which is what a stampede lease is for', async () => {
  const dir = await scratch()
  const store = sharedLeases(memoryStore(), { dir })
  const held = await store.lease('render:/feed', 60_000)
  assert.ok(held)
  assert.equal(await inAnotherProcess(dir, 'render:/feed'), false)
  held.release()
  // The release is fire-and-forget by design — nothing waits on an unlink — so give it a tick.
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(await inAnotherProcess(dir, 'render:/feed'), true)
})

test('an expired lease is taken over rather than held forever by a process that went away', async () => {
  const dir = await scratch()
  let now = 1_000_000
  const gone = sharedLeases(memoryStore(), { dir, clock: () => now })
  assert.ok(await gone.lease('render:/feed', 1_000), 'a process took it and then crashed')

  now += 999
  assert.equal(await gone.lease('render:/feed', 1_000), null, 'still inside its lifetime')
  now += 2
  assert.ok(await gone.lease('render:/feed', 1_000), 'past it, so it is stealable')
})

test('the cache stays where it was: only the lease is shared, and the store says so', () => {
  // `scope` decides whether a private entry may be written to a tier. Making the leases shared does
  // not make the cache shared, and a store that claimed otherwise would let a private render reach
  // somewhere it can be served to the wrong person.
  const base = memoryStore()
  const store = sharedLeases(base, { dir: dirs[0] ?? tmpdir() })

  assert.equal(store.scope, 'process', 'entries live exactly where they did')
  assert.equal(store.leaseScope, 'shared', 'and only the agreement about leases is wider')
  assert.equal(base.leaseScope, undefined, 'an unwrapped store has one answer for both, so it says one')
})

test('what a store holds is unchanged by wrapping it, because only one method is replaced', async () => {
  const dir = await scratch()
  const store = sharedLeases(memoryStore(), { dir })
  await store.set('k', new TextEncoder().encode('v'), { class: 'shared', tags: ['t'] })
  assert.equal(new TextDecoder().decode((await store.get('k'))?.value), 'v')
  assert.deepEqual(await store.invalidate(['t']), ['k'])
  assert.equal(await store.get('k'), null)
})
