/**
 * Renderers a worker can reach by name. Nothing here closes over anything, which is the whole
 * constraint a pool imposes: a closure cannot cross a thread boundary.
 */
export function greeting(props?: unknown): string {
  const name = (props as { name?: string } | undefined)?.name ?? 'world'
  return `<p>hello ${name}</p>`
}

export function bytes(): Uint8Array {
  return new TextEncoder().encode('<p>raw</p>')
}

/**
 * A tight synchronous loop with no await in it, which is exactly what an inline CPU budget
 * cannot stop and a worker can.
 */
export function spin(props?: unknown): string {
  const ms = (props as { ms?: number } | undefined)?.ms ?? 1_000
  const until = Date.now() + ms
  let n = 0
  while (Date.now() < until) n++
  return `<p>${n}</p>`
}

export function explode(): string {
  throw new Error('the renderer threw')
}

export const notAFunction = 42

/**
 * A render that waits rather than computes: no CPU at all, for as long as it is asked.
 *
 * The case a wall-clock budget gets wrong. A fragment waiting on a database has spent nothing
 * this executor exists to bound, and killing it turns a slow dependency into a degraded page.
 */
export async function waits(props?: unknown): Promise<string> {
  const ms = (props as { ms?: number } | undefined)?.ms ?? 200
  await new Promise((resolve) => setTimeout(resolve, ms))
  return `<p>waited ${ms}</p>`
}
