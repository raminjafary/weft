import { signal, type Readable } from './signal.ts'

/**
 * The one channel between a shell and the regions inside it, on the client.
 *
 * A region is a fragment that renders somewhere else, and its client code runs in a page it did not
 * assemble. It cannot reach the shell's variables — they are in another deployment's module graph —
 * and it must not reach for a global, because a global that happens to exist on one page and not on
 * another is exactly the coupling a composed page cannot afford. So there is one table, the shell
 * declares what goes in it, and a region declares what it reads out.
 *
 * Both halves are checked, at different times and for different reasons.
 *
 * **At build time**, `E_NOT_EXPOSED`: a region consuming a name the shell does not expose fails the
 * build. That is the check worth having, because it catches the mistake before anybody deploys.
 *
 * **At run time**, `E_NOT_EXPOSED` again: `read` refuses a name that is not in the table. Not
 * redundant — a region is deployed independently, so it can be a version ahead of the shell
 * composing it, and the whole point of a declared channel is that widening it is not something a
 * region can do on its own. A region asking for something it was never granted gets a refusal rather
 * than `undefined`, which is the difference between a bug you find and a value that is quietly empty.
 *
 * What a region gets back is a `Readable`, so it participates in the signal graph like anything
 * else: reading it inside a derived value subscribes, and a `SIGNAL` frame changing it recomputes
 * exactly the nodes that read it. There is no write side. A region cannot set a shell signal, and
 * that asymmetry is the design's — the exposed set is a shell offering values, not a shared bus.
 */
export interface Exposure {
  /**
   * The signal behind an exposed name. Refuses a name the shell did not expose.
   *
   * A `Readable` rather than a value, because a region that read a snapshot would have to be told
   * when to read again — and the thing that knows is the graph, not the region.
   */
  read(name: string): Readable<string>
  /** What the shell offers. For a devtools page, and for a region asking what it may have. */
  readonly names: string[]
  /**
   * The shell's declaration: every exposed name, at the values this page rendered with.
   *
   * Sent once, by the server, in the frame that arrives when a channel opens — the same moment and
   * for the same reason `PLAN` does, which is that the client cannot ask a question it does not know
   * it has. This *is* the set: it replaces whatever was held, because a set that only ever grew could
   * be grown by anything that got a frame through.
   */
  declare(values: Record<string, string>): void
  /**
   * A new value for an exposed name. False for a name outside the declared set.
   *
   * Returns rather than throws, and that asymmetry with `read` is deliberate. `read` is called by a
   * region's own code, so a refusal there is a programming error and belongs in a stack trace. This
   * is called by a frame router with a value that came off the wire from a deployment nobody here
   * controls — a refusal is data, and a page that threw because another team sent a bad frame would
   * have thrown away the isolation the tier boundary was for.
   */
  set(name: string, value: string): boolean
}

/**
 * The table, and why it starts empty.
 *
 * A region's *first* render already has the values it consumes: the composite resolved them and
 * handed them across the boundary, so the markup that arrives is correct without anything on the
 * client having happened. What this table is for is the second value and every one after it — and a
 * shell signal that changes needs a live channel by definition, so the set arriving with the channel
 * rather than in the document costs a page with no channel nothing it could have used.
 *
 * The set comes from one frame, and that is the security property. It is the server's own frame,
 * sent when the connection opens, and it replaces rather than merges — so a region that sent a
 * `SIGNAL` naming a shell signal cannot add one, and a region that named an exposed one is refused
 * because its frames have to name themselves. A shared table that anything could write to would be
 * a global with extra steps, which is what the declared channel exists instead of.
 */
export function createExposure(initial: Record<string, string> = {}): Exposure {
  const signals = new Map<string, { set(next: string): void; read: Readable<string> }>()

  /**
   * A name's signal, and the read-only face of it a region gets.
   *
   * Handing out the `Signal` itself would hand out its `set`, and a region that could write a shell
   * signal is a shared bus rather than a shell offering values — the asymmetry is the design's. The
   * façade is built once per name so a region can hold onto it, and so two reads of the same name are
   * the same object rather than two nodes in the graph.
   */
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

  /**
   * The refusal, and why its message is short.
   *
   * Every other error in this package spells out the reasoning, because the reader is a developer
   * with the source open. This one lands in `boot.ts` — the module every page on every weft
   * deployment downloads — so the prose lives in the comment above, which is stripped, and the wire
   * carries the code, the name and the set it was checked against. That is what a reader needs to act
   * and it is what a page can afford.
   */
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
      // Replaced, not merged. A name the shell has stopped exposing has to stop being readable, or
      // a region would keep reading the last value it ever saw and nothing would say so.
      for (const name of signals.keys()) if (!(name in values)) signals.delete(name)
      // An existing name keeps its signal and takes a new value. Handing out a fresh one on every
      // reconnection would orphan every subscription a region had already taken against the old one.
      for (const [name, value] of Object.entries(values)) put(name, value)
    },
    set: (name, value) => {
      const found = signals.get(name)
      if (found) found.set(value)
      return Boolean(found)
    },
  }
}

/**
 * `SIGNAL` frames, routed into the exposure table.
 *
 * Through `onFrame` rather than a case in the channel client, for the reason `navFrames` is: a page
 * that composes no region should not carry the handler, and the channel entry has fifteen bytes of
 * headroom. A capability that owns a frame kind carries its own routing.
 */
export function exposedFrames(
  exposure: Exposure,
  report?: (line: string) => void,
): (frame: { kind: string; header: Record<string, string | number | boolean>; body?: Uint8Array }) => void {
  const utf8 = new TextDecoder()
  return (frame) => {
    if (frame.kind !== 'SIGNAL') return
    const name = frame.header.name
    /**
     * No name and a body is the declaration; a name is one value changing.
     *
     * One frame kind for both because they are the same statement at two grains — here is what the
     * shell offers — and a second kind would have cost every entry carrying the frame table a few
     * bytes to say something the body already says.
     */
    if (name === undefined) {
      if (frame.body) {
        exposure.declare(JSON.parse(utf8.decode(frame.body)) as Record<string, string>)
        report?.(`SIGNAL declared ${exposure.names}`)
      }
      return
    }
    const value = String(frame.header.v ?? '')
    // Reported either way. A refused signal is the most interesting one there is — it means a
    // deployment is sending a name this shell never offered — and dropping it silently would make
    // that indistinguishable from a frame that never arrived.
    report?.(
      exposure.set(String(name), value)
        ? `SIGNAL ${String(name)}=${value}`
        : `SIGNAL ${String(name)} refused: not exposed`,
    )
  }
}
