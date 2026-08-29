import type { Adopted } from './adopt.ts'
import type { Json } from './template.ts'
import { batch } from './signal.ts'

const PATH = /^([^[.]+)(?:\[(\d+)\])?$/

/** A delta as it arrives: the template, the base it applies to, and the changed values. */
export interface DeltaPayload {
  tpl: string
  base: string
  changed: Record<string, Json>
}

/** The delta form, applied: one write per changed value, no region re-projected. See `spec/kernel/surgical.md`. */
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
    const last = i === tokens.length - 1

    if (index === undefined) {
      if (last) return { node: current, binding: key }
      // Named rather than indexed. See `spec/ir/template-ir-2.md`: Payloads.
      const instance = current.instances[key]
      if (!instance) return undefined
      current = instance
      continue
    }

    const row = current.rows[index]
    if (!row) return undefined
    current = row
    if (last) return undefined
  }
  return undefined
}

/** Whether a delta's base is the render this client actually holds. */
export function baseMatches(held: string, delta: DeltaPayload): boolean {
  return held === delta.base
}
