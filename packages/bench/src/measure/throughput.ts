export interface ThroughputResult {
  /** Nanoseconds per render, one sample per batch. */
  samples: number[]
  bytesPerRender: number
  totalOps: number
}

export interface ThroughputOptions {
  batches: number
  opsPerBatch: number
  warmupOps: number
}

/**
 * Batched timing: a single render is faster than the clock is precise, so each sample
 * is the mean of a batch. Sinks the output length so the work cannot be eliminated.
 */
export function measureThroughput(render: () => Uint8Array, options: ThroughputOptions): ThroughputResult {
  let sink = 0
  for (let i = 0; i < options.warmupOps; i++) sink += render().length

  const samples: number[] = []
  let bytesPerRender = 0
  for (let b = 0; b < options.batches; b++) {
    const start = process.hrtime.bigint()
    for (let i = 0; i < options.opsPerBatch; i++) sink += render().length
    const elapsed = Number(process.hrtime.bigint() - start)
    samples.push(elapsed / options.opsPerBatch)
    bytesPerRender = render().length
  }
  if (sink < 0) throw new Error('unreachable')
  return { samples, bytesPerRender, totalOps: options.batches * options.opsPerBatch + options.warmupOps }
}

export function opsPerSecond(nsPerOp: number): number {
  return 1e9 / nsPerOp
}
