import { budgets, deltas, forms, versions } from '../api.ts'
import { escapeHtml, explain, field, panel, pick, pre, press, readout, slider } from '../pages.ts'
import { ageOf, appProfile, MIN_SAMPLES } from 'weft'
import type { StationHandler } from './kind.ts'

const n = (value: number): string => value.toLocaleString('en-US')

/**
 * The measurement stations. Everything on them comes out of `@weft/bench`, which is the rule the
 * design's build notes state and the reason these pages are worth trusting: a demo with its own
 * measurement path is a demo that will disagree with the harness.
 */
export const byteBudgets: StationHandler = async () => {
  const report = await budgets()
  return {
    panel: panel(
      '',
      'Nothing to drive here. The numbers come from bundling each entry, so the control is editing the framework.',
    ),
    body: async () =>
      readout(
        'Every entry, measured against its ceiling',
        report.entries.map((entry) => ({
          label: entry.label,
          value: `${n(entry.brotli)} B`,
          note: `ceiling ${n(entry.limit)} · gzip ${n(entry.gzip)} · raw ${n(entry.raw)} — ${entry.note}`,
          state: entry.within ? ('within' as const) : ('over' as const),
        })),
        {
          what: `Brotli-compressed size of each bundle entry against its stated ceiling. The design states one server-side figure, “under 8 KB”, and it covers the document request path only. Every other capability has its own entry, so the first feature to arrive cannot spend the headroom for all the later ones.`,
          from: report.provenance.from,
          caveat: report.provenance.caveat,
          tryThis:
            'Compare the content route with the app route. The difference is the update path, which a page that only reads never imports.',
        },
      ),
  }
}

export const sharedDeltas: StationHandler = async (ctx) => {
  const clients = Math.min(2_000, Math.max(2, Number(ctx.query('clients') ?? 200)))
  const report = await deltas(clients)
  const rows = report.rows.map((row) => ({
    label: `${row.arrival === 'aligned' ? 'one base' : 'own base'} · ${row.strategy}`,
    value: `${n(row.computations)} diffs`,
    note: `${n(row.memoized)} from the memo · ${n(row.storeReads)} store reads · ${row.ms} ms · ${n(row.bytesDelivered)} B delivered`,
    state: row.strategy === 'shared' && row.arrival === 'aligned' ? ('within' as const) : ('plain' as const),
  }))
  return {
    panel: panel(
      [field('clients', slider('delta-clients', 10, 2000, clients, 10)), press('delta-run', 'measure')].join(
        '',
      ),
      'Two arrival patterns are measured, because only one of them favours this design.',
    ),
    body: async () =>
      readout(
        `${n(report.clients)} clients, ${report.changedRows} of ${report.totalRows} rows changed`,
        rows,
        {
          what: `How many times the server computes a diff when N clients make the same transition. A per-connection differ — which is what LiveView's architecture is, by construction rather than by choice — keeps the previous render in a process per connection, so it computes N of them. Keeping that state on the client makes a delta a pure function of two content-addressed states, so one computation serves every client on the same base. The second pair of rows is the case where clients hold different bases: nothing is shared, and the shared path is then measurably worse, because it pays a store round trip per client on top of the same diffs.`,
          from: report.provenance.from,
          caveat: report.provenance.caveat,
          tryThis:
            'Raise the client count. The aligned “shared” row stays at one diff; every other row scales with it.',
        },
      ),
  }
}

export const wireForms: StationHandler = async (ctx) => {
  const id = ctx.query('scenario') ?? 'feed'
  const report = await forms(id)
  const rows = report.checks
    .map(
      (check) =>
        `<tr><td class="${check.ok ? 'ok' : 'no'}">${check.ok ? 'pass' : 'FAIL'}</td><td>${escapeHtml(check.name)}</td><td class="note">${escapeHtml(check.detail ?? '')}</td></tr>`,
    )
    .join('')
  return {
    panel: panel(
      [
        field('scenario', pick('form-scenario', ['cart', 'feed', 'slow-feed'], id)),
        press('form-run', 'check'),
      ].join(''),
      'This is the differential test the harness refuses to publish numbers without.',
    ),
    body: `<div class="card"><h3>Every form of ${escapeHtml(report.scenario)}, checked against every other</h3>
      <table class="forms"><thead><tr><th></th><th>check</th><th>detail</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${explain({
        what: `A negotiated wire form is only safe if every form of a fragment produces identical bytes. Each row is one such comparison: a pre-encoded segment render against a string render, a delta applied to its base against a fresh render of the next state, and an incremental render against a full one — cold memo and warm.`,
        from: report.provenance.from,
        caveat: report.provenance.caveat,
        tryThis:
          'Switch scenario. `slow-feed` is the same fragment behind a 40 ms query, so the bytes are identical and only the timing differs.',
      })}`,
  }
}

export const devices: StationHandler = async () => {
  const v = versions()
  return {
    panel: panel(
      '',
      'A baseline is not a control. It is what every other number on this site is a number about.',
    ),
    body: async () =>
      readout(
        'What this build is',
        [
          {
            label: 'Template IR',
            value: v.ir,
            note: 'the wire format resident clients and cache keys depend on',
          },
          {
            label: 'Warp',
            value: v.warp,
            note: 'the frame vocabulary; a major mismatch costs the channel, never the page',
          },
          {
            label: 'Out-of-order filler',
            value: `${n(v.fillerBytes)} B`,
            note: 'the price of fastest-first streaming, loaded only when a slot asks to stream',
          },
        ],
        {
          what: `The versions this process is running, and the one byte figure that is a consequence rather than a budget. The filler is the script that moves a node into a slot that has already closed; in-order streaming never loads it, which is why the streaming-order station reports it only at the moment you switch.`,
          from: v.provenance.from,
          caveat: v.provenance.caveat,
          tryThis:
            'Read spec/baseline/devices.md beside this. Every timing claim in the repo names the device class it came from.',
        },
      ),
    readout: pre(
      `From spec/baseline/devices.md:

  A claim measured on a developer laptop is a claim about a developer laptop.
  Browser numbers in this repository come from Playwright's Chromium, Firefox
  and WebKit on this machine. WebKit there is a desktop proxy, labelled as one
  everywhere it appears, and it is not an iOS number.`,
    ),
  }
}

/**
 * The station whose subject is a recording, and which has nothing to show without one.
 *
 * A profile is evidence: it says what this deployment's renders cost and what that decides about
 * delivery. So the page reads the live one rather than describing the idea — and when there is no
 * recording it says so and says how to make one, because a page that invented plausible numbers
 * for a demonstration would be the exact mistake the whole feature exists to avoid.
 */
export const profileStation: StationHandler = async () => {
  const app = appProfile()
  const rows = app
    ? app.decisions.routes.flatMap((route) =>
        route.slots.map((decision) => ({
          label: `${route.route} · ${decision.slot}`,
          value: decision.delivery === 'stream' ? `stream prio ${decision.prio ?? 0}` : 'buffered',
          note: decision.because,
          state: (decision.delivery === 'stream' ? 'over' : 'within') as 'over' | 'within',
        })),
      )
    : []

  return {
    panel: panel(
      '',
      app
        ? `Recorded ${ageOf(app.profile)}, over ${Math.round(app.profile.forMs / 1000)}s. Every row below is a decision and the renders it rests on.`
        : 'Nothing recorded. Serve with `profile: true` or `weft dev --profile`, take some traffic, and this page fills in — it will not invent numbers to have something to show.',
    ),
    body: async () =>
      readout(
        app ? 'What the measurement decided' : 'No recording',
        rows.length
          ? rows
          : [
              {
                label: 'decisions',
                value: 'none yet',
                note: app
                  ? `no slot has reached ${MIN_SAMPLES} renders. ${app.decisions.thin.length} slot(s) are being watched`
                  : 'this process is not recording',
                state: 'plain' as const,
              },
            ],
        {
          what: `The convention generates a plan from the file tree, which cannot say what any of it costs — and delivery is a decision about cost. So delivery, and only delivery, is decided from renders: a slow region on a page with a fast one streams, a page whose regions are uniformly fast buffers so the out-of-order filler stays off the wire, and a slot with fewer than ${MIN_SAMPLES} renders decides nothing at all.`,
          from: 'decide() over .weft/profile.json in weft, which is what generated the plan this page is served by',
          caveat:
            'A profile describes a deployment at a moment. An old one looks exactly like a current one, which is why the panel above states its age rather than only its contents.',
          tryThis:
            'Compare a row with what the route declares. Where they disagree, the measurement won — and where a slot is missing, it is nearly always a cache hit, whose delivery hardly matters.',
        },
      ),
  }
}
