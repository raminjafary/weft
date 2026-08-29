import { intentId } from '@weftjs/compiler'
import type { Intent, RegionBinding, Registry } from '@weftjs/kernel'

/**
 * A registry built from a manifest: every intent the build found, keyed by the opaque id the
 * compiler derived. Derived here, not declared — a manifest that spelled its own ids could
 * disagree with the templates.
 */
export interface ManifestEntry {
  module: string
  export: string
  intent: Intent<never>
}

/** A registry plus the manifest it answered from, for a build report and for `weft verify`. */
export interface ManifestRegistry extends Registry {
  /** The id an entry got, for a build report and for `weft why`. */
  idFor(module: string, exportName: string): string
  /** Point a region somewhere else, without rebuilding the shell that composes it. See `spec/kernel/composition.md`. */
  roll(binding: RegionBinding): void
  /** Narrowed from the port's optional, possibly-async shape: a manifest is a map and answers now. */
  region(name: string): RegionBinding | undefined
  regions(): readonly string[]
}

/** The manifest a registry resolves against, and what a name it does not know does. */
export interface ManifestOptions {
  /**
   * Region name to the deployment serving it. Separate from the intent entries: an intent id
   * changes with the code, a region binding changes when somebody rolls a tier.
   */
  regions?: readonly RegionBinding[]
}

/** Region names to deployments, from a manifest. Ids derived with the same function the compiler used. */
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
