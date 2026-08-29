import { readsOf, render, type Values } from '@weftjs/ir'
import { adoptScript, fragmentIR, type CompiledFragment } from '@weftjs/core'

/**
 * A live example: a real file under `app/fragments/examples/`, not a pasted code block. Type-checked
 * by the repo's own `tsc`, compiled by `weft build`, and `fragmentIR` hands back the exact sealed
 * template the page's renderer used — no separate compile step or snapshot to keep in sync.
 */
export interface Example {
  /** The fragment's convention name: `examples/badge` is `app/fragments/examples/badge.tsx`. */
  id: string
  title: string
  /** What the example is for, in one sentence. */
  shows: string
  /** What to render it with. A thunk for values that are a function of something live — a plain object once froze the feedback example's vote count at 0. */
  values?: Values | (() => Values)
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
  /** The payload binding this example's template to the markup, or null for a constant template with nothing to attach to. Before this field existed, the signals example rendered a dead input. */
  adopt: string | null
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
  /** What the client attaches on adoption, one row per entry — an `event` row names an intent by its opaque id, never the export it came from. */
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

/** Called at render time, so a thunk sees the tally as it is now rather than as it was at import. */
function resolveValues(values: Example['values']): Values {
  if (typeof values === 'function') return values()
  return values ?? {}
}

/**
 * A signal's declared initial value, seeded into the render. `render` doesn't know a binding is a
 * signal, so an unsupplied one renders empty — invisible on an adopting page but permanent here,
 * since these examples never adopt: the signals example once rendered a `signal(1)` as `value=""`
 * with its derived total at `0`. An explicit value still wins.
 */
function withSignals(entry: CompiledFragment['entry'], values: Values): Values {
  const seeded: Record<string, unknown> = {}
  for (const declaration of entry.signals) {
    if (declaration.init !== undefined) seeded[declaration.id] = declaration.init
  }
  return { ...seeded, ...(values as Record<string, unknown>) } as Values
}

/** Render one example. Throws rather than degrading — `docs.test.ts` renders every example in the registry so a broken one fails the build, not a silent empty box. */
export function renderExample(example: Example): RenderedExample {
  const fragment = fragmentIR(example.id)
  const values = withSignals(fragment.entry, resolveValues(example.values))
  return {
    id: example.id,
    title: example.title,
    shows: example.shows,
    ...(example.note ? { note: example.note } : {}),
    file: fragment.file,
    source: fragment.source,
    html: decoder.decode(render(fragment.entry, values, fragment.resolve)),
    adopt: adoptScript(example.id, fragment, values, { selector: `[data-example="${example.id}"]` }),
    facts: facts(fragment),
  }
}
