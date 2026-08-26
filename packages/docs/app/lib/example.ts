import { readsOf, render, type Values } from '@weft/ir'
import { fragmentIR, type CompiledFragment } from 'weft'

/**
 * A live example: a fragment this application compiled, rendered with values this page supplies.
 *
 * The roadmap line this site exists to close asked for "a documentation site whose every example
 * is live", and the load-bearing word is *this*. An example here is not a code block that was
 * pasted from something that worked once — it is a real file under `app/fragments/examples/`, so:
 *
 * - The repository's own `tsc` type-checks it, which is what makes the escape-elision examples
 *   honest: elision is a type question, and a snippet nobody checked has no types to elide by.
 * - `weft build` compiles it. An example that does not compile is a build that does not pass, so a
 *   broken example cannot ship.
 * - `fragmentIR` hands back the *same* sealed template the renderer beside it used. The holes, the
 *   escape decisions, the read set and the version on the page are that template's, not a second
 *   compilation's that could disagree with it.
 * - The source shown is `CompiledFragment.source` — the bytes that produced those holes, carried by
 *   the build rather than re-read from a path that may have changed since.
 *
 * There is no separate compile step and no snapshot to keep in sync. The page is a view over the
 * application it is part of.
 */
export interface Example {
  /** The fragment's convention name: `examples/badge` is `app/fragments/examples/badge.tsx`. */
  id: string
  title: string
  /** What the example is for, in one sentence. */
  shows: string
  /** What to render it with. A fragment with no props takes none. */
  values?: Values
  /** What to look at in the output. Optional, and usually worth writing. */
  note?: string
}

export interface RenderedExample {
  id: string
  title: string
  shows: string
  note?: string
  /** The file, project-relative. */
  file: string
  /** The bytes on disk that produced the template below. */
  source: string
  /** What it rendered, as markup. */
  html: string
  facts: ExampleFacts
}

export interface ExampleFacts {
  /** The sealed template's content address. */
  version: string
  /** How many sealed templates this fragment is: itself, plus every row and instance inside it. */
  templates: number
  /** One row per hole: what it binds, what kind of hole it is, and how it escapes. */
  holes: { binding: string; kind: string; escape: string }[]
  /** What the compiler inferred this fragment reads. Empty is the interesting case. */
  reads: string[]
  /** The wire forms this template can serve, derived rather than declared. */
  forms: string[]
  /**
   * What the client attaches on adoption, one row per entry.
   *
   * This is the cost model made visible: not "how many components", but how many places in this
   * template a value reaches. An `event` row names an intent by its opaque id rather than by the
   * export it came from, which is the property that keeps server code off the wire.
   */
  wiring: { op: string; binding: string; target: string }[]
  /** Client-owned state this template declares, and its initial value as rendered. */
  signals: { id: string; type: string; init: string }[]
  /** Values computed from other bindings, with what each expression reads. */
  derived: string[]
}

function facts(fragment: CompiledFragment): ExampleFacts {
  const { entry } = fragment
  return {
    version: entry.version,
    templates: fragment.templates.length,
    holes: entry.holes.map((hole) => ({ binding: hole.binding, kind: hole.kind, escape: hole.escape })),
    reads: [...entry.effects.reads],
    forms: [...entry.forms],
    wiring: entry.wiring.map((wire) => ({
      op: wire.op,
      binding: wire.intent ? `intent ${wire.intent}` : wire.binding,
      // An element path is what the client walks. Printed as written, because a reader comparing it
      // to the markup above should see the same numbers the runtime uses.
      target: [wire.attr ?? wire.event ?? 'text', `at [${wire.path.join(', ')}]`].join(' '),
    })),
    signals: entry.signals.map((signal) => ({
      id: signal.id,
      type: signal.type,
      init: JSON.stringify(signal.init ?? null),
    })),
    derived: entry.derived.map((decl) => `${decl.id} ← ${readsOf(decl.expr).join(', ') || 'a constant'}`),
  }
}

const decoder = new TextDecoder()

/**
 * Render one example.
 *
 * It throws rather than degrading, and `test/docs.test.ts` renders every example in the registry
 * for exactly that reason: an example page that swallowed a failure would print an empty box, and
 * an empty box is the one thing a documentation site must not be able to do quietly.
 */
export function renderExample(example: Example): RenderedExample {
  const fragment = fragmentIR(example.id)
  return {
    id: example.id,
    title: example.title,
    shows: example.shows,
    ...(example.note ? { note: example.note } : {}),
    file: fragment.file,
    source: fragment.source,
    html: decoder.decode(render(fragment.entry, example.values ?? {}, fragment.resolve)),
    facts: facts(fragment),
  }
}
