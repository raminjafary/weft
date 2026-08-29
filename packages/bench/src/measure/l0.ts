import { build, createApp, discover, loadBuild, loadConfig, serveApp } from '@weftjs/core/server'
import { measureHttp, type HttpSample } from './http.ts'
import { summarize, type Summary } from '../stats.ts'

/** What the kernel costs for a document whose bytes are already known. See `spec/kernel/static.md`. */
export interface L0Report {
  root: string
  path: string
  bytes: number
  iterations: number
  l0: { ttfb: Summary; ttlb: Summary }
  kernel: { ttfb: Summary; ttlb: Summary }
}

export interface L0Options {
  root: string
  iterations: number
  warmup: number
  /** Which document to measure. Defaults to the largest one the build wrote. */
  path?: string
}

function summarise(samples: HttpSample[]): { ttfb: Summary; ttlb: Summary } {
  return {
    ttfb: summarize(samples.map((s) => s.ttfbHeaders)),
    ttlb: summarize(samples.map((s) => s.ttlb)),
  }
}

export async function measureL0(options: L0Options): Promise<L0Report> {
  const report = await build(options.root)
  if (!report.static.length) {
    throw new Error(
      `E_NO_STATIC_DOCUMENTS: ${options.root} has no L0 document to measure. ` +
        `weft build says why for each route.`,
    )
  }
  const chosen =
    (options.path
      ? report.static.find((document) => document.pattern === options.path)
      : [...report.static].sort((a, b) => b.bytes - a.bytes)[0]) ?? null
  if (!chosen) {
    throw new Error(
      `E_NO_SUCH_DOCUMENT: ${options.path} is not one of ${report.static.map((d) => d.pattern).join(', ')}`,
    )
  }

  const config = await loadConfig(options.root, {})
  const discovered = await discover(options.root, config.srcDir)
  const compiled = await loadBuild(discovered, config)
  const app = await createApp(options.root, { mode: 'start', compiled, port: 0 })
  const serving = await serveApp(app)

  try {
    const url = new URL(chosen.pattern, serving.url).href
    const sampling = { iterations: options.iterations, warmup: options.warmup, connection: 'warm' as const }

    const served = await measureHttp(url, sampling)
    const held = app.documents.get(chosen.pattern)
    if (!held) throw new Error(`E_NOT_SERVED: ${chosen.pattern} is not in the document table`)

    app.documents.delete(chosen.pattern)
    const rendered = await measureHttp(url, sampling)
    app.documents.set(chosen.pattern, held)

    const fileBytes = served[0]?.bytes ?? 0
    const renderBytes = rendered[0]?.bytes ?? 0
    if (fileBytes !== renderBytes) {
      throw new Error(
        `E_NOT_THE_SAME_DOCUMENT: the file is ${fileBytes} B and the render is ${renderBytes} B, ` +
          `so there is no comparison to make`,
      )
    }

    return {
      root: options.root,
      path: chosen.pattern,
      bytes: fileBytes,
      iterations: options.iterations,
      l0: summarise(served),
      kernel: summarise(rendered),
    }
  } finally {
    await serving.close()
  }
}

function line(label: string, s: { ttfb: Summary; ttlb: Summary }): string {
  return (
    `  ${label.padEnd(22)}ttfb ${s.ttfb.p50.toFixed(3)} ms   ttlb ${s.ttlb.p50.toFixed(3)} ms  ` +
    `(p95 ${s.ttlb.p95.toFixed(3)})`
  )
}

export function formatL0(report: L0Report): string {
  const speedup = report.kernel.ttlb.p50 / report.l0.ttlb.p50
  return [
    '',
    `  ${report.path} — ${report.bytes} B, ${report.iterations} warm samples on one connection`,
    '',
    line('L0, from the table', report.l0),
    line('kernel, warm store', report.kernel),
    '',
    `  ${speedup.toFixed(2)}× on last byte, for a document both paths agree on to the byte.`,
    '  The kernel run has a warm store, so this is the render it does not have to do plus the',
    '  key derivation, the plan and the stream that it does. Cold, the gap is the render.',
    '',
  ].join('\n')
}
