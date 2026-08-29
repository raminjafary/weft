/** Something to run when a value it read has changed. */
export type Subscriber = () => void

/** Anything a wiring entry can bind to: a signal, or a value computed from signals. */
export interface Readable<T> {
  (): T
  subscribe(run: Subscriber): () => void
}

/** A readable value that can be written. Writing marks its readers stale and recomputes nothing. */
export interface Signal<T> extends Readable<T> {
  set(next: T): void
}

/** A value derived from others. Readable, never writable — the expression is the definition. */
export type Computed<T> = Readable<T>

// Edges are doubly linked in both directions. See `spec/client/signals.md`.
interface Link {
  dep: Node
  sub: Node
  prevDep: Link | undefined
  nextDep: Link | undefined
  prevSub: Link | undefined
  nextSub: Link | undefined
}

interface Node {
  flags: number
  /** As a dependency: the head and tail of the list of edges pointing at this node. */
  subs: Link | undefined
  subsTail: Link | undefined
  /** As a subscriber: the head and tail of the list of edges this node reads through. */
  deps: Link | undefined
  depsTail: Link | undefined
  value?: unknown
  fn?: () => unknown
}

// Status is bitflags on one integer field. See `spec/client/signals.md`.
const MUTABLE = 1 << 0 /* recomputes its own value: a computed */
const WATCHING = 1 << 1 /* runs an effect when it settles dirty */
const DIRTY = 1 << 2 /* a direct dependency changed */
const PENDING = 1 << 3 /* something upstream changed; may or may not have reached here */
const QUEUED = 1 << 4 /* already in the flush queue */
const TRACKED = 1 << 5 /* re-reads its dependencies on every run */

let activeSub: Node | undefined
let batchDepth = 0
let flushing = false
const queue: Node[] = []

/** A value and its edges. Built on the shape of the TC39 Signals proposal so it can be deleted rather than migrated when that ships. */
export function signal<T>(initial: T): Signal<T> {
  const node: Node = {
    flags: 0,
    subs: undefined,
    subsTail: undefined,
    deps: undefined,
    depsTail: undefined,
    value: initial,
  }

  const read = (() => {
    if (activeSub !== undefined) link(node, activeSub)
    return node.value as T
  }) as Signal<T>

  read.set = (next: T): void => {
    if (next === node.value) return
    node.value = next
    if (node.subs !== undefined) propagate(node.subs, DIRTY)
    flush()
  }

  read.subscribe = (run) => watch(node, run)
  return read
}

/** A value derived from other values. Lazy: recomputes on read, only after a pull confirms something it reads changed. See `spec/client/signals.md`. */
export function computed<T>(fn: () => T): Computed<T> {
  const node: Node = {
    flags: MUTABLE | DIRTY,
    subs: undefined,
    subsTail: undefined,
    deps: undefined,
    depsTail: undefined,
    value: undefined,
    fn: fn as () => unknown,
  }

  const read = (() => {
    if (node.flags & (DIRTY | PENDING)) update(node)
    if (activeSub !== undefined) link(node, activeSub)
    return node.value as T
  }) as Computed<T>

  read.subscribe = (run) => {
    if (node.flags & (DIRTY | PENDING)) update(node)
    return watch(node, run)
  }
  return read
}

/** Runs now, tracking whatever it reads, and again whenever any of it changes. The auto-tracking front door; `subscribe` is the narrow one. */
export function effect(fn: () => void): () => void {
  const node: Node = {
    flags: WATCHING | TRACKED,
    subs: undefined,
    subsTail: undefined,
    deps: undefined,
    depsTail: undefined,
    fn,
  }
  runNode(node)
  return () => dispose(node)
}

/** Several writes as one notification, so a subscriber sees the end state and not each step. */
export function batch(work: () => void): void {
  batchDepth++
  try {
    work()
  } finally {
    batchDepth--
    flush()
  }
}

/** Reads inside `fn` establish no dependency. */
export function untrack<T>(fn: () => T): T {
  const prev = activeSub
  activeSub = undefined
  try {
    return fn()
  } finally {
    activeSub = prev
  }
}

// A watcher bound to exactly one dependency, tracking nothing, that does not run on creation. See `spec/client/signals.md`.
function watch(dep: Node, run: Subscriber): () => void {
  const node: Node = {
    flags: WATCHING,
    subs: undefined,
    subsTail: undefined,
    deps: undefined,
    depsTail: undefined,
    fn: run,
  }
  link(dep, node)
  return () => dispose(node)
}

function dispose(node: Node): void {
  let edge = node.deps
  while (edge !== undefined) edge = unlink(edge, node)
  node.flags = 0
}

function link(dep: Node, sub: Node): void {
  const prevDep = sub.depsTail
  if (prevDep !== undefined && prevDep.dep === dep) return
  const nextDep = prevDep === undefined ? sub.deps : prevDep.nextDep
  if (nextDep !== undefined && nextDep.dep === dep) {
    sub.depsTail = nextDep
    return
  }

  const edge: Link = { dep, sub, prevDep, nextDep, prevSub: dep.subsTail, nextSub: undefined }
  sub.depsTail = edge
  if (prevDep === undefined) sub.deps = edge
  else prevDep.nextDep = edge
  if (nextDep !== undefined) nextDep.prevDep = edge
  if (dep.subsTail === undefined) dep.subs = edge
  else dep.subsTail.nextSub = edge
  dep.subsTail = edge
}

function unlink(edge: Link, sub: Node): Link | undefined {
  const { dep, prevDep, nextDep, prevSub, nextSub } = edge

  if (nextDep !== undefined) nextDep.prevDep = prevDep
  else sub.depsTail = prevDep
  if (prevDep !== undefined) prevDep.nextDep = nextDep
  else sub.deps = nextDep

  if (nextSub !== undefined) nextSub.prevSub = prevSub
  else dep.subsTail = prevSub
  if (prevSub !== undefined) prevSub.nextSub = nextSub
  else dep.subs = nextSub

  // A computed nobody watches any more goes cold: it drops its own edges and will
  // recompute from scratch if anyone reads it again.
  if (dep.subs === undefined && dep.flags & MUTABLE) {
    dep.flags |= DIRTY
    let inner = dep.deps
    while (inner !== undefined) inner = unlink(inner, dep)
  }
  return nextDep
}

// Push. See `spec/client/signals.md`: "Propagation is push, then pull".
function propagate(from: Link, mark: number): void {
  let edge: Link | undefined = from
  do {
    const sub = edge.sub
    const flags = sub.flags
    if ((flags & (DIRTY | PENDING)) === 0) {
      sub.flags = flags | mark
      if (flags & WATCHING) enqueue(sub)
      else if (sub.subs !== undefined) propagate(sub.subs, PENDING)
    } else if (mark === DIRTY && (flags & DIRTY) === 0) {
      // Already reached as pending on another path; downstream is marked already.
      sub.flags = (flags & ~PENDING) | DIRTY
    }
    edge = edge.nextSub
  } while (edge !== undefined)
}

function enqueue(node: Node): void {
  if (node.flags & QUEUED) return
  node.flags |= QUEUED
  queue.push(node)
}

// Pull. See `spec/client/signals.md`: "Propagation is push, then pull".
function checkDirty(node: Node): boolean {
  if (node.flags & DIRTY) {
    node.flags &= ~(DIRTY | PENDING)
    return true
  }
  if ((node.flags & PENDING) === 0) return false

  let dirty = false
  for (let edge = node.deps; edge !== undefined; edge = edge.nextDep) {
    const dep = edge.dep
    if (dep.flags & MUTABLE && dep.flags & (DIRTY | PENDING) && update(dep)) {
      dirty = true
      break
    }
  }
  node.flags &= ~(DIRTY | PENDING)
  return dirty
}

/** Recomputes if it has to, and reports whether the value moved. */
function update(node: Node): boolean {
  if ((node.flags & DIRTY) === 0 && !checkDirty(node)) return false
  const prev = node.value
  runNode(node)
  return node.value !== prev
}

function runNode(node: Node): void {
  const prevSub = activeSub
  activeSub = node
  node.depsTail = undefined
  node.flags &= ~(DIRTY | PENDING)
  try {
    const next = (node.fn as () => unknown)()
    if (node.flags & MUTABLE) node.value = next
  } finally {
    // Whatever this run did not read is no longer a dependency.
    const tail = node.depsTail as Link | undefined
    let stale = tail === undefined ? node.deps : tail.nextDep
    while (stale !== undefined) stale = unlink(stale, node)
    activeSub = prevSub
  }
}

function flush(): void {
  if (batchDepth > 0 || flushing) return
  flushing = true
  try {
    // Re-read the length every turn: an effect that writes queues more work, and that
    // work belongs to this flush rather than to a second one.
    for (let i = 0; i < queue.length; i++) {
      const node = queue[i] as Node
      node.flags &= ~QUEUED
      if (!(node.flags & WATCHING)) continue
      if (!checkDirty(node)) continue
      if (node.flags & TRACKED) runNode(node)
      else (node.fn as Subscriber)()
    }
  } finally {
    queue.length = 0
    flushing = false
  }
}
