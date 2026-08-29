import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { declarationOf, extendsOf, functionsIn, interfacesIn, typeAliasesIn } from './declared.ts'

/**
 * Every seam the kernel refuses to know about, and what fills it. Three facts, none typed here:
 * the `*Port` interfaces the kernel declares, the `@weftjs/adapters` functions returning one
 * (resolved through a branded alias where there is one), and the `WeftConfig` key naming that
 * port. `docs.test.ts` holds the page's counts to the source.
 */
export interface Implementation {
  name: string
  /** The first paragraph of its doc comment. */
  summary: string
  /** Repository-relative. */
  file: string
}

export interface Port {
  /** `StorePort`. */
  name: string
  /** The first paragraph of its doc comment. */
  doc: string
  file: string
  /** The `weft.config.ts` option that binds it, or empty when only the front door does. */
  key: string
  implementations: Implementation[]
}

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const KERNEL = 'packages/kernel/src/ports.ts'
const ADAPTERS = 'packages/adapters/src'
const CONFIG = 'packages/weft/src/config.ts'

/** The first paragraph, which is what a table row has room for. */
function opening(doc: string): string {
  return (doc.split(/\n\s*\n/)[0] ?? '').replace(/\s+/g, ' ').trim()
}

let cached: Port[] | null = null

export function ports(): Port[] {
  if (cached) return cached
  const found: Port[] = interfacesIn(KERNEL)
    .filter((name) => name.endsWith('Port'))
    .map((name) => ({
      name,
      doc: opening(declarationOf(KERNEL, name).doc),
      file: KERNEL,
      key: '',
      implementations: [],
    }))

  const byName = new Map(found.map((port) => [port.name, port]))
  const aliases = new Map<string, string>()
  const files: string[] = []
  for (const entry of readdirSync(join(ROOT, ADAPTERS))) {
    if (!entry.endsWith('.ts') || entry.endsWith('.d.ts')) continue
    const file = `${ADAPTERS}/${entry}`
    files.push(file)
    for (const name of interfacesIn(file)) {
      for (const base of extendsOf(file, name)) {
        if (byName.has(base)) aliases.set(name, base)
      }
    }
    // `export type LeasedStore = StorePort & { … }` — the other half of the same idea, and the one
    // `redisLeases` returns. An intersection is still a store; a reader asking what can be one
    // should find it under `StorePort` rather than nowhere.
    for (const alias of typeAliasesIn(file)) {
      for (const port of found) {
        if (new RegExp(`\\b${port.name}\\b`).test(alias.type)) aliases.set(alias.name, port.name)
      }
    }
  }

  for (const file of files) {
    for (const fn of functionsIn(file)) {
      const port = byName.get(fn.returns) ?? byName.get(aliases.get(fn.returns) ?? '')
      if (!port) continue
      port.implementations.push({ name: fn.name, summary: opening(fn.doc), file })
    }
  }
  for (const port of found) port.implementations.sort((a, b) => a.name.localeCompare(b.name))

  // Matches on the port's name appearing in the type, not being exactly it — `limits?: LimitPort | { counted: CountedAgainst }` names its port inside a union.
  for (const field of declarationOf(CONFIG, 'WeftConfig').fields) {
    for (const port of found) {
      if (!port.key && new RegExp(`\\b${port.name}\\b`).test(field.type)) port.key = field.name
    }
  }

  cached = found.sort((a, b) => a.name.localeCompare(b.name))
  return cached
}

/** How many ports have something in `@weftjs/adapters` that returns one. */
export function implemented(): number {
  return ports().filter((port) => port.implementations.length > 0).length
}

/** How many a deployment can take over from `weft.config.ts`. The rest the front door binds. */
export function bindable(): number {
  return ports().filter((port) => port.key).length
}
