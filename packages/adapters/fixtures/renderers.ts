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
