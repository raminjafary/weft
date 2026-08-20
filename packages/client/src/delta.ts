import type { Adopted } from './adopt.ts'
import type { Json } from './template.ts'
import { batch } from './signal.ts'

const PATH = /^([^[.]+)(?:\[(\d+)\])?$/

export interface DeltaPayload {
  tpl: string
  base: string
  changed: Record<string, Json>
}

/**
 * The delta form, applied where it was always supposed to be applied: into the DOM the
 * server already rendered, one write per changed value. No region is re-projected and no
 * markup is parsed, which is only possible because every hole carries its own addressing.
 */
export function applyDelta(adopted: Adopted, delta: DeltaPayload): number {
  let writes = 0
  batch(() => {
    for (const [path, value] of Object.entries(delta.changed)) {
      const target = resolve(adopted, path)
      if (!target) continue
      target.node.write(target.binding, value)
      writes++
    }
  })
  return writes
}

function resolve(adopted: Adopted, path: string): { node: Adopted; binding: string } | undefined {
  const tokens = path.split('.')
  let current = adopted
  for (let i = 0; i < tokens.length; i++) {
    const match = PATH.exec(tokens[i] as string)
    if (!match) return undefined
    const key = match[1] as string
    const index = match[2] === undefined ? undefined : Number(match[2])

    if (index === undefined) {
      if (i === tokens.length - 1) return { node: current, binding: key }
      return undefined
    }

    const row = current.rows[index]
    if (!row) return undefined
    current = row
    if (i === tokens.length - 1) return undefined
  }
  return undefined
}

/** Whether a delta's base is the render this client actually holds. */
export function baseMatches(held: string, delta: DeltaPayload): boolean {
  return held === delta.base
}
