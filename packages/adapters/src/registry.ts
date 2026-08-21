import { intentId } from '@weft/compiler'
import type { Intent, Registry } from '@weft/kernel'

/**
 * A registry built from a manifest, which is the deployment shape a bundler produces: every
 * intent the build found, keyed by the opaque id the compiler derived for its module and
 * export.
 *
 * The id is derived here rather than declared, from the same function the compiler used to
 * write it into the wiring. That is the point — a manifest that spelled its own ids could
 * disagree with the templates, and the disagreement would look like an intent that silently
 * does nothing.
 */
export interface ManifestEntry {
  module: string
  export: string
  intent: Intent<never>
}

export interface ManifestRegistry extends Registry {
  /** The id an entry got, for a build report and for `weft why`. */
  idFor(module: string, exportName: string): string
}

export function manifestRegistry(entries: readonly ManifestEntry[]): ManifestRegistry {
  const byId = new Map<string, Intent<never>>()
  for (const entry of entries) {
    const id = intentId(entry.module, entry.export)
    const existing = byId.get(id)
    if (existing) {
      throw new Error(
        `E_INTENT_ID_COLLISION: ${entry.module}#${entry.export} and another entry both hash to ${id}`,
      )
    }
    byId.set(id, entry.intent)
  }
  return {
    name: 'manifest',
    idFor: intentId,
    intent: (id) => byId.get(id) as Intent | undefined,
    intents: () => [...byId.keys()],
  }
}
