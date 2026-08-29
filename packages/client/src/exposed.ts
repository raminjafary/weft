import { signal, type Readable } from './signal.ts'

/** The one channel between a shell and the regions inside it, on the client. See `spec/kernel/composition.md`: "The exposed set, routed". */
export interface Exposure {
  /** The signal behind an exposed name. Refuses a name the shell did not expose. */
  read(name: string): Readable<string>
  /** What the shell offers. For a devtools page, and for a region asking what it may have. */
  readonly names: string[]
  /** The shell's declaration: every exposed name, at the values this page rendered with. Replaces, never merges. */
  declare(values: Record<string, string>): void
  /** A new value for an exposed name. False for a name outside the declared set — returns rather than throws, deliberately. */
  set(name: string, value: string): boolean
}

/** The table, and why it starts empty. See `spec/kernel/composition.md`: "The exposed set, routed". */
export function createExposure(initial: Record<string, string> = {}): Exposure {
  const signals = new Map<string, { set(next: string): void; read: Readable<string> }>()

  /** A name's signal, and the read-only face of it a region gets. Built once per name. */
  const put = (name: string, value: string): void => {
    const existing = signals.get(name)
    if (existing) {
      existing.set(value)
      return
    }
    const held = signal(value)
    const read = (() => held()) as Readable<string>
    read.subscribe = (run) => held.subscribe(run)
    signals.set(name, { set: (next) => held.set(next), read })
  }

  for (const [name, value] of Object.entries(initial)) put(name, value)

  // Terse: this lands in boot.ts, which every page downloads. See `spec/kernel/static.md`.
  return {
    get names() {
      return [...signals.keys()]
    },
    read: (name) => {
      const found = signals.get(name)
      if (!found) throw new Error(`E_NOT_EXPOSED: '${name}' — this page exposes ${[...signals.keys()]}`)
      return found.read
    },
    declare: (values) => {
      // Replaced, not merged. See `spec/kernel/composition.md`.
      for (const name of signals.keys()) if (!(name in values)) signals.delete(name)
      // An existing name keeps its signal; a fresh one would orphan its subscriptions.
      for (const [name, value] of Object.entries(values)) put(name, value)
    },
    set: (name, value) => {
      const found = signals.get(name)
      if (found) found.set(value)
      return Boolean(found)
    },
  }
}

/** `SIGNAL` frames, routed into the exposure table. Through `onFrame`, not a case in the channel client: a page composing no region shouldn't carry the handler. */
export function exposedFrames(
  exposure: Exposure,
  report?: (line: string) => void,
): (frame: { kind: string; header: Record<string, string | number | boolean>; body?: Uint8Array }) => void {
  const utf8 = new TextDecoder()
  return (frame) => {
    if (frame.kind !== 'SIGNAL') return
    const name = frame.header.name
    // No name and a body is the declaration; a name is one value changing. See `spec/kernel/composition.md`.
    if (name === undefined) {
      if (frame.body) {
        exposure.declare(JSON.parse(utf8.decode(frame.body)) as Record<string, string>)
        report?.(`SIGNAL declared ${exposure.names}`)
      }
      return
    }
    const value = String(frame.header.v ?? '')
    // Reported either way: a dropped refusal looks exactly like a frame that never arrived.
    report?.(
      exposure.set(String(name), value)
        ? `SIGNAL ${String(name)}=${value}`
        : `SIGNAL ${String(name)} refused: not exposed`,
    )
  }
}
