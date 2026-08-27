import { relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { intentId } from '@weftjs/compiler'
import type { Intent, IntentLimit, IntentRoute, Registry } from '@weftjs/kernel'

/**
 * The intent manifest, generated from a directory.
 *
 * `manifestRegistry` in `@weftjs/adapters` has always been able to consume one of these; nothing
 * produced one. This is that producer, and the derivation is deliberately the same function the
 * compiler used to write the id into a template's wiring — a manifest that spelled its own ids
 * could disagree with the templates, and that disagreement looks exactly like an intent that
 * silently does nothing.
 */
export interface ManifestEntry {
  /** The module id, relative to the project root and slash-separated, as the compiler states it. */
  module: string
  export: string
  /** Six hex characters, derived from the two fields above and from nothing else. */
  id: string
  /** The intent's own declared name, for a diagnostic and for a plain HTML form's action. */
  name: string
  writes: string[]
  /** Capabilities the caller must hold. The closed set the config's grants are checked against. */
  capabilities: string[]
  /** Reachable only with a token this deployment minted. See `spec/kernel/authority.md`. */
  signed: boolean
  /** How much traffic this mutation says it can take. What it is counted against is the port's. */
  limit?: IntentLimit
}

/** Every intent, by the opaque id the compiler derived, with what each one declares. */
export interface IntentManifest {
  entries: ManifestEntry[]
  registry: Registry
  /** Name to id, which is what a page ships so markup written by hand can name one. */
  names: Record<string, string>
  /** `POST /_weft/i/<id>` and `POST /_weft/i/<name>`, for the no-JavaScript path. */
  routes: IntentRoute[]
}

function looksLikeIntent(value: unknown): value is Intent<never> {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { name?: unknown; run?: unknown }
  return typeof candidate.name === 'string' && typeof candidate.run === 'function'
}

/** A module's identity, relative to the project — so an id does not depend on the checkout path. */
export function moduleIdOf(root: string, file: string): string {
  return relative(root, file).split(sep).join('/')
}

/** Load `app/intents/**` into a closed set, refusing two intents that would share an id. */
export async function loadIntents(root: string, files: readonly string[]): Promise<IntentManifest> {
  const entries: ManifestEntry[] = []
  const byId = new Map<string, Intent<never>>()
  const names: Record<string, string> = {}

  for (const file of files) {
    const module_ = (await import(pathToFileURL(file).href)) as Record<string, unknown>
    const moduleId = moduleIdOf(root, file)
    for (const [exportName, value] of Object.entries(module_)) {
      if (!looksLikeIntent(value)) continue
      const id = intentId(moduleId, exportName)
      const clash = entries.find((e) => e.id === id)
      if (clash) {
        throw new Error(
          `E_INTENT_ID_COLLISION: ${moduleId}#${exportName} and ${clash.module}#${clash.export} both hash to ${id}`,
        )
      }
      const declared = value.name
      if (names[declared]) {
        throw new Error(
          `E_INTENT_NAME_TAKEN: two intents are called '${declared}'. A name is what markup writes, so it has to be unique`,
        )
      }
      entries.push({
        module: moduleId,
        export: exportName,
        id,
        name: declared,
        writes: [...(value.writes ?? [])],
        capabilities: [...(value.capabilities ?? [])],
        signed: value.signed === true,
        ...(value.limit ? { limit: value.limit } : {}),
      })
      names[declared] = id
      byId.set(id, value)
    }
  }

  const registry: Registry = {
    name: 'weft-manifest',
    intent: (id) => byId.get(id) ?? byId.get(names[id] ?? ''),
    intents: () => entries.map((e) => e.id),
  }

  const routes: IntentRoute[] = entries.flatMap((entry) => [
    { method: 'POST', pattern: `/_weft/i/${entry.id}`, intent: entry.id },
    // The same dispatch under the author's own name, so a plain `<form action>` can reach it
    // with no JavaScript. What travels on the *wire* is still the id; this is markup a person
    // wrote, and a form whose action is unguessable is a form nobody can write.
    { method: 'POST', pattern: `/_weft/i/${entry.name}`, intent: entry.id },
  ])

  return { entries, registry, names, routes }
}
