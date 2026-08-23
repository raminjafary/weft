/**
 * The station list, and the honest part of this whole directory.
 *
 * The design's demo is explicitly **not a subset**: if a capability is in the specs, it has a
 * station here. That is only a meaningful promise if it is checked, so every station names the
 * spec documents it covers and `demo/test/stations.test.ts` fails the build when a spec document
 * has no station pointing at it. A capability that ships without one is a broken build rather
 * than a gap somebody notices in six months.
 *
 * `status` is the second half of the honesty. `live` means the mechanism runs when you open the
 * page — and the same test refuses to let a station claim it without a handler registered, so it
 * cannot be aspirational. `planned` means the capability is built and this page is not.
 * `refused` means the capability does not exist, and the page says so and links to the roadmap
 * entry rather than mocking it. Better an honest empty station than a mock.
 */
export type StationStatus = 'live' | 'planned' | 'refused'

export interface Station {
  id: string
  title: string
  /** What the page demonstrates. One sentence, in the design's own words where it has them. */
  shows: string
  /** The control the visitor gets. A demo without one is documentation with a screenshot. */
  control: string
  /** Spec documents this station is the live version of. Checked for coverage. */
  covers: readonly string[]
  status: StationStatus
  /** For `refused`: the roadmap heading that explains what is missing. */
  roadmap?: string
  group: 'render' | 'client' | 'cache' | 'plan' | 'stream' | 'wire' | 'locus' | 'budget'
}

export const STATIONS: readonly Station[] = [
  // ── streaming ──────────────────────────────────────────────────────────────────────
  {
    id: 'streaming',
    title: 'Streaming',
    shows: 'A route with slow regions streaming into slots, and a first byte that does not wait for them',
    control: 'A latency slider per region, and the round-trip time',
    covers: ['kernel/streaming.md'],
    status: 'live',
    group: 'stream',
  },
  {
    id: 'streaming-order',
    title: 'Streaming order',
    shows: 'in-order against out-of-order, same page, side by side',
    control: 'A toggle, and the slow region’s delay. The filler cost appears as a number when you switch',
    covers: ['kernel/streaming.md'],
    status: 'live',
    group: 'stream',
  },
  {
    id: 'blocking-control',
    title: 'Blocking control',
    shows: 'The same route awaiting its loader, so the difference is something you produce rather than read',
    control: 'The same sliders',
    covers: ['kernel/streaming.md'],
    status: 'live',
    group: 'stream',
  },

  // ── the client runtime ─────────────────────────────────────────────────────────────
  {
    id: 'adoption',
    title: 'Adoption',
    shows: 'A server-rendered region becoming interactive with no component code running',
    control: 'A binding count — the point is that cost tracks bindings, not components',
    covers: ['client/adoption.md'],
    status: 'live',
    group: 'client',
  },
  {
    id: 'signals',
    title: 'Signals',
    shows: 'One signal driving several nodes',
    control: 'Write frequency, and a counter of DOM writes against signal writes',
    covers: ['client/signals.md'],
    status: 'live',
    group: 'client',
  },
  {
    id: 'derived',
    title: 'Derived values',
    shows: 'A derived value recomputing on the client from an expression that travelled on the wire',
    control:
      'Edit the signal; a toggle showing that a derived value landing on the same result writes nothing',
    covers: ['client/signals.md'],
    status: 'live',
    group: 'client',
  },
  {
    id: 'controls',
    title: 'Controls',
    shows: 'A prop binding surviving a user’s edit, which an attribute-only write does not',
    control: 'Type into the input, then push a new value. An attribute-only mode shows the bug it fixes',
    covers: ['client/adoption.md'],
    status: 'live',
    group: 'client',
  },
  {
    id: 'deltas',
    title: 'Deltas',
    shows: 'One changed value becoming one DOM write, with no markup parsed and no region re-projected',
    control: 'Edit any value; a highlight on exactly the nodes that were written',
    covers: ['ir/template-ir-2.md'],
    status: 'live',
    group: 'wire',
  },

  // ── the compiler ───────────────────────────────────────────────────────────────────
  {
    id: 'components',
    title: 'Components',
    shows: 'Composition across modules, one child used many times, and one sealed template',
    control: 'A count of instances against the number of sealed templates. It stays at one',
    covers: ['compiler/supported-subset.md'],
    status: 'live',
    group: 'render',
  },
  {
    id: 'escaping',
    title: 'Escaping',
    shows: 'Escape classes, including trusted-raw and where its provenance comes from',
    control: 'Paste markup into a value and watch where it is and is not escaped',
    covers: ['compiler/supported-subset.md'],
    status: 'live',
    group: 'render',
  },
  {
    id: 'effects',
    title: 'Effects and caching',
    shows: 'The inferred read set of a live fragment, and the cache class derived from it',
    control: 'Toggle each ctx read on; watch the class, Vary, and the key components change',
    covers: ['compiler/effects.md'],
    status: 'live',
    group: 'cache',
  },
  {
    id: 'contagion',
    title: 'Contagion',
    shows: 'A private fragment inside a shared route, and the instance the compiler isolated for it',
    control:
      'Make the child private; watch the route’s class stay shared and the instance become its own unit',
    covers: ['compiler/effects.md'],
    status: 'live',
    group: 'cache',
  },

  // ── cache ──────────────────────────────────────────────────────────────────────────
  {
    id: 'cache-keys',
    title: 'Cache keys',
    shows: 'The same reads resolved into a key, derived and never written',
    control: 'Edit a cookie, a header, a flag; watch the key change and the hit turn into a miss',
    covers: ['kernel/cache.md'],
    status: 'live',
    group: 'cache',
  },
  {
    id: 'static-documents',
    title: 'Static documents',
    shows: 'The classifier that decides a page is a file, and the two-render probe that decides it is not',
    control:
      'Give the page a loader that reads something the compiler cannot see, and watch the verdict change',
    covers: ['kernel/static.md'],
    status: 'live',
    group: 'cache',
  },
  {
    id: 'stampede',
    title: 'Stampede',
    shows: 'N concurrent misses on one key, and the one render they share',
    control: 'A concurrency slider and a render counter',
    covers: ['kernel/cache.md'],
    status: 'live',
    group: 'cache',
  },

  // ── the plan ───────────────────────────────────────────────────────────────────────
  {
    id: 'routing',
    title: 'Routing',
    shows: 'A path matching a plan by specificity, and the plan becoming a route',
    control: 'Type a path; watch which pattern wins, what params it captured, and the plan that lowered',
    covers: ['kernel/routing.md'],
    status: 'live',
    group: 'plan',
  },
  {
    id: 'shell-boundaries',
    title: 'Shell boundaries',
    shows: 'A plan whose slots disagree with the shell’s holes, refused at build',
    control:
      'Add a slot the shell does not have; watch the build refuse it and name the boundaries it does leave',
    covers: ['plan/plan.md'],
    status: 'live',
    group: 'plan',
  },
  {
    id: 'ports',
    title: 'Ports',
    shows: 'Thirteen declared, seven implemented, and what an unimplemented one does when you call it',
    control: 'Call each port; watch six answer and the rest refuse by name',
    covers: ['kernel/ports.md'],
    status: 'live',
    group: 'plan',
  },

  // ── the envelope ───────────────────────────────────────────────────────────────────
  {
    id: 'envelope',
    title: 'The envelope',
    shows: 'Phase A against phase B, as two different context types rather than one with a flag',
    control:
      'Try to set a cookie in a render and watch the type refuse it; move it to a guard and watch a real 302',
    covers: ['kernel/lifecycle.md'],
    status: 'live',
    group: 'plan',
  },
  {
    id: 'early-hints',
    title: 'Early hints',
    shows: '103 against a flush-to-discover baseline',
    control: 'A toggle, and the shell’s critical link set; watch when the browser starts fetching',
    covers: ['kernel/lifecycle.md'],
    status: 'live',
    group: 'stream',
  },

  // ── locus ──────────────────────────────────────────────────────────────────────────
  {
    id: 'waves',
    title: 'Waves',
    shows: 'The DAG, its waves, and the critical path',
    control: 'Drag a needs edge; watch the critical path move and the sequential figure stay where it was',
    covers: ['kernel/locus.md'],
    status: 'live',
    group: 'locus',
  },
  {
    id: 'budgets',
    title: 'Budgets',
    shows: 'A slot over its CPU budget, and the five different pages one breach can produce',
    control: 'A slowness slider and an onExceed picker',
    covers: ['kernel/locus.md'],
    status: 'live',
    group: 'locus',
  },
  {
    id: 'worker-pool',
    title: 'The worker pool',
    shows: 'The difference between a budget that reports and a budget that stops the work',
    control: 'A synchronous-loop slider, and a choice of executor',
    covers: ['kernel/locus.md'],
    status: 'live',
    group: 'locus',
  },
  {
    id: 'epochs',
    title: 'Epochs',
    shows: 'Data arrived, resolved, and painting nothing',
    control:
      'A stage button and a commit button, with a half-typed form to prove the commit did not disturb it',
    covers: ['kernel/locus.md'],
    status: 'live',
    group: 'locus',
  },

  // ── surgical updates ───────────────────────────────────────────────────────────────
  {
    id: 'shared-deltas',
    title: 'Shared deltas',
    shows: 'N clients making one transition, and the one computation that serves them',
    control: 'A client count and an arrival pattern; watch computations stay at one, or not',
    covers: ['kernel/surgical.md'],
    status: 'live',
    group: 'wire',
  },
  {
    id: 'incremental',
    title: 'Incremental recompute',
    shows: 'A long list where three rows changed, and the three row renders it costs',
    control: 'A row count and how many of them change; a reorder button',
    covers: ['kernel/surgical.md'],
    status: 'live',
    group: 'wire',
  },
  {
    id: 'transport',
    title: 'The channel',
    shows: 'The same flow over a streamed response, an SSE stream, and a WebSocket',
    control: 'A binding picker, and a frame log in both directions',
    covers: ['kernel/transport.md'],
    status: 'live',
    group: 'wire',
  },
  {
    id: 'intents',
    title: 'Intents',
    shows: 'The only thing allowed to write, and an optimistic update whose rollback is a discarded epoch',
    control: 'Submit with JavaScript off and on; make it fail and watch the guess disappear',
    covers: ['kernel/intents.md'],
    status: 'live',
    group: 'plan',
  },

  // ── the wire ───────────────────────────────────────────────────────────────────────
  {
    id: 'wire-forms',
    title: 'The wire forms',
    shows: 'html, bundle, split, patch and delta, with the equivalence check running live',
    control: 'A form picker and a byte counter, with brotli sizes',
    covers: ['ir/template-ir-2.md'],
    status: 'live',
    group: 'wire',
  },
  {
    id: 'warp',
    title: 'Warp',
    shows: 'WARP, SHELL and TPL frames in the document itself',
    control: 'A frame inspector, and a switch for a cold visit against a warm one',
    covers: ['warp/warp-1.md'],
    status: 'live',
    group: 'wire',
  },
  {
    id: 'residency',
    title: 'Residency',
    shows: 'Repeat visits with templates already held',
    control: 'A “forget everything” button, and the boot path timed in both states',
    covers: ['warp/warp-1.md'],
    status: 'live',
    group: 'wire',
  },
  {
    id: 'negotiation',
    title: 'Negotiation',
    shows: 'A client that speaks an older IR, and what it costs',
    control: 'A version picker; watch forms drop and html survive',
    covers: ['warp/warp-1.md'],
    status: 'live',
    group: 'wire',
  },

  // ── measurement ────────────────────────────────────────────────────────────────────
  {
    id: 'byte-budgets',
    title: 'Byte budgets',
    shows: 'Every entry measured against its ceiling, from the real bundle',
    control: 'A per-entry breakdown, produced by the same code as the benchmark report',
    covers: ['kernel/budgets.md'],
    status: 'live',
    group: 'budget',
  },
  {
    id: 'devices',
    title: 'The device baseline',
    shows: 'What the numbers on every other station are numbers about',
    control: 'The baseline as stated, and what each figure does and does not cover',
    covers: ['baseline/devices.md'],
    status: 'live',
    group: 'budget',
  },

  {
    id: 'profile',
    title: 'Plans from a profile',
    shows: "What this deployment's renders cost, and what that decided about delivery",
    control: 'None: the page reads the live recording, and says so when there is not one',
    covers: ['plan/profile.md'],
    status: 'live',
    group: 'budget',
  },
  {
    id: 'navigation',
    title: 'Instant navigation',
    shows: 'A route staged on hover, and a click that is a DOM swap rather than a request',
    control: 'Three links: one the framework may stage, one told not to, and one off this origin',
    covers: ['client/navigation.md'],
    status: 'live',
    group: 'client',
  },
  // ── authority and discovery ────────────────────────────────────────────────────────
  {
    id: 'authority',
    title: 'Capabilities',
    shows:
      'The same requirement decided for two callers, against a real role table, with the missing grant named',
    control: 'A role, and what the intent requires — including two capabilities at once',
    covers: ['kernel/authority.md'],
    status: 'live',
    group: 'cache',
  },
  {
    id: 'signed-intents',
    title: 'Signed intents',
    shows: 'A token minted and checked live, and every way it can be the wrong token',
    control: 'A failure to induce: replayed, another payload, another intent, another reader, another key',
    covers: ['kernel/authority.md', 'kernel/intents.md'],
    status: 'live',
    group: 'cache',
  },
  {
    id: 'discovery',
    title: 'Lazy plan extension',
    shows:
      'A subtree of the plan described rather than rendered, and the shell answer that saves a round trip',
    control: 'A prefix, and how many routes one frame may carry',
    covers: ['kernel/routing.md', 'client/navigation.md'],
    status: 'live',
    group: 'plan',
  },
]

export const BY_ID: Record<string, Station> = Object.fromEntries(STATIONS.map((s) => [s.id, s]))

export const GROUPS: { id: Station['group']; label: string }[] = [
  { id: 'render', label: 'The compiler' },
  { id: 'stream', label: 'Streaming' },
  { id: 'client', label: 'The client runtime' },
  { id: 'cache', label: 'Effects and caching' },
  { id: 'plan', label: 'Plans, ports and the envelope' },
  { id: 'locus', label: 'Where work runs' },
  { id: 'wire', label: 'The wire' },
  { id: 'budget', label: 'Measurement' },
]
