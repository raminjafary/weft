import {
  checkScenario,
  measureBudgets,
  measureSharedDelta,
  scenario,
  segmentsCandidate,
  stringSsrCandidate,
} from '@weftjs/bench'
import { fillerSize } from '@weftjs/kernel'
import { TEMPLATE_IR_VERSION } from '@weftjs/ir'
import { WARP_VERSION } from '@weftjs/warp'

/**
 * Every number this demo shows comes from here, and everything here calls the benchmark harness.
 *
 * That is a rule from the design's own build notes and it is the difference between a demo and a
 * brochure: a demo with its own measurement path is a demo that will disagree with the harness,
 * and the disagreement will be discovered by somebody who trusted the demo.
 *
 * Each endpoint returns its own provenance — which function produced the number and what the
 * number does not cover — so a station can print that next to the figure instead of asking you to
 * take it on faith.
 */
export interface Provenance {
  /** The function that produced these numbers. */
  from: string
  /** What this measurement does not cover. Printed with the result, every time. */
  caveat: string
}

export interface BudgetReport {
  provenance: Provenance
  entries: {
    id: string
    label: string
    raw: number
    gzip: number
    brotli: number
    limit: number
    within: boolean
    note: string
  }[]
}

export async function budgets(): Promise<BudgetReport> {
  const sizes = await measureBudgets()
  return {
    provenance: {
      from: 'measureBudgets() in @weftjs/bench — Rolldown, minified, brotli quality 11',
      caveat:
        'These are bundle sizes, not transfer sizes: a real response also carries HTTP framing, and a real deployment may not tree-shake identically to Rolldown. The ceilings marked “no design figure” are watermarks whose only job is to make a regression visible.',
    },
    entries: sizes.map((size) => ({
      id: size.id,
      label: size.label,
      raw: size.raw,
      gzip: size.gzip,
      brotli: size.brotli,
      limit: size.limit,
      within: size.within,
      note: size.limitNote,
    })),
  }
}

export interface DeltaReport {
  provenance: Provenance
  clients: number
  changedRows: number
  totalRows: number
  rows: {
    arrival: string
    strategy: string
    computations: number
    memoized: number
    storeReads: number
    ms: number
    bytesDelivered: number
  }[]
}

export async function deltas(clients: number): Promise<DeltaReport> {
  const report = await measureSharedDelta(scenario('feed'), clients)
  return {
    provenance: {
      from: 'measureSharedDelta() in @weftjs/bench — the same differ on both sides, over the same templates',
      caveat:
        'Phoenix is not running here. The per-connection figure is a real per-connection differ in this harness, so what is compared is the architecture and not BEAM scheduling, Phoenix wire encoding, or its tracked comprehensions. Both arrival patterns are shown because only one of them favours this design.',
    },
    clients: report.clients,
    changedRows: report.changedRows,
    totalRows: report.totalRows,
    rows: report.results.map((r) => ({
      arrival: r.arrival,
      strategy: r.strategy,
      computations: r.computations,
      memoized: r.memoized,
      storeReads: r.storeReads,
      ms: Number(r.ms.toFixed(2)),
      bytesDelivered: r.bytesDelivered,
    })),
  }
}

export interface FormsReport {
  provenance: Provenance
  scenario: string
  checks: { name: string; ok: boolean; detail?: string }[]
}

export async function forms(id: string): Promise<FormsReport> {
  const report = await checkScenario(scenario(id), [segmentsCandidate, stringSsrCandidate])
  return {
    provenance: {
      from: 'checkScenario() in @weftjs/bench — the same differential test the harness refuses to publish numbers without',
      caveat:
        'This proves the forms agree byte for byte. It says nothing about which form is faster to apply, which is a separate axis measured in a real engine.',
    },
    scenario: report.scenario,
    checks: report.checks.map((c) => {
      const check: { name: string; ok: boolean; detail?: string } = { name: c.name, ok: c.ok }
      if (c.detail) check.detail = c.detail
      return check
    }),
  }
}

export interface VersionReport {
  provenance: Provenance
  ir: string
  warp: string
  fillerBytes: number
}

export function versions(): VersionReport {
  return {
    provenance: {
      from: 'the version constants in @weftjs/ir and @weftjs/warp, and fillerSize() in @weftjs/kernel',
      caveat:
        'The filler figure is the cost of out-of-order streaming and nothing else. In-order streaming does not load it, which is why the streaming-order station reports it only when you switch.',
    },
    ir: TEMPLATE_IR_VERSION,
    warp: WARP_VERSION,
    fillerBytes: fillerSize(),
  }
}
