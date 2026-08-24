import { intentId } from '@weft/compiler'
import type { Intent, RegionBinding, Registry } from '@weft/kernel'

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
  /**
   * Point a region somewhere else, without rebuilding the shell that composes it.
   *
   * This is the sentence the registry port exists for: rolling a region to a new revision is a
   * write here rather than a redeploy of everything that names it. A checked-in manifest is
   * immutable on disk and this is the in-memory shape of the same write — a KV namespace or a
   * control plane implements the identical method against something durable, and nothing above
   * the port can tell the difference.
   */
  roll(binding: RegionBinding): void
  /** Narrowed from the port's optional, possibly-async shape: a manifest is a map and answers now. */
  region(name: string): RegionBinding | undefined
  regions(): readonly string[]
}

export interface ManifestOptions {
  /**
   * Region name to the deployment serving it. A shell says `search`; this is what `search` is.
   *
   * Separate from the intent entries above because they answer different questions with different
   * lifetimes. An intent id is derived from code and changes when the code does; a region binding
   * is operational and changes when somebody rolls a tier.
   */
  regions?: readonly RegionBinding[]
}

export function manifestRegistry(
  entries: readonly ManifestEntry[],
  options: ManifestOptions = {},
): ManifestRegistry {
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
  const byRegion = new Map<string, RegionBinding>()
  for (const binding of options.regions ?? []) {
    if (byRegion.has(binding.region)) {
      throw new Error(`E_REGION_DECLARED_TWICE: ${binding.region} is bound twice in one manifest`)
    }
    byRegion.set(binding.region, binding)
  }
  return {
    name: 'manifest',
    idFor: intentId,
    intent: (id) => byId.get(id) as Intent | undefined,
    intents: () => [...byId.keys()],
    region: (name) => byRegion.get(name),
    regions: () => [...byRegion.keys()],
    roll: (binding) => {
      byRegion.set(binding.region, binding)
    },
  }
}
