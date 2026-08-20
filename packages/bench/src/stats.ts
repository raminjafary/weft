export interface Summary {
  n: number
  min: number
  p50: number
  p95: number
  p99: number
  max: number
  mean: number
  stddev: number
  /** Median absolute deviation, which survives the outliers a timing run always has. */
  mad: number
}

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  const a = sorted[lo] as number
  const b = sorted[hi] as number
  return a + (b - a) * (pos - lo)
}

export function summarize(samples: number[]): Summary {
  const sorted = [...samples].sort((a, b) => a - b)
  const n = sorted.length
  const mean = sorted.reduce((a, b) => a + b, 0) / (n || 1)
  const variance = sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (n > 1 ? n - 1 : 1)
  const p50 = quantile(sorted, 0.5)
  const deviations = sorted.map((v) => Math.abs(v - p50)).sort((a, b) => a - b)
  return {
    n,
    min: sorted[0] ?? NaN,
    p50,
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    max: sorted[n - 1] ?? NaN,
    mean,
    stddev: Math.sqrt(variance),
    mad: quantile(deviations, 0.5),
  }
}

/**
 * Whether two runs differ by more than their own noise. Cheap and conservative:
 * non-overlapping p50 +/- MAD. A harness that reports a 3% win it cannot resolve is
 * worse than one that reports nothing.
 */
export function separable(a: Summary, b: Summary): boolean {
  const loA = a.p50 - a.mad
  const hiA = a.p50 + a.mad
  const loB = b.p50 - b.mad
  const hiB = b.p50 + b.mad
  return hiA < loB || hiB < loA
}

export function ratio(a: number, b: number): number {
  return b === 0 ? NaN : a / b
}
