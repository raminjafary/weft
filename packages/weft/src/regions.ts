import type { RegionBinding, Renderable, Registry } from '@weft/kernel'

/**
 * The registry the front door binds, which is two ports wearing one interface.
 *
 * `Registry` answers two questions with different lifetimes: an opaque id to the intent it names,
 * and a region name to the deployment serving it. An intent id is derived from code and changes
 * when the code does; a region binding is operational and changes when somebody rolls a tier. So
 * they come from two places — the generated manifest and `weft.config.ts` — and are joined here
 * rather than in either of them.
 *
 * A bound `registry` is asked first and the config's `regions` answer whatever it does not resolve.
 * That order is the one that makes a control plane worth binding: the checked-in table is the
 * fallback a deployment can read in review, and the live one is allowed to disagree with it.
 */
export function regionRegistry(
  intents: Registry,
  options: {
    regions?: readonly RegionBinding[]
    registry?: Registry
    /** The catalogue, looked up late because it is built from ports that carry this registry. */
    renderable?(id: string): Renderable | undefined
    renderables?(): readonly string[]
  } = {},
): Registry {
  const declared = new Map<string, RegionBinding>()
  for (const binding of options.regions ?? []) {
    if (declared.has(binding.region)) {
      throw new Error(
        `E_REGION_DECLARED_TWICE: '${binding.region}' is bound twice in weft.config.ts, so two ` +
          `entries claim to say where one region is`,
      )
    }
    declared.set(binding.region, binding)
  }
  const bound = options.registry
  const names = [...new Set([...(bound?.regions?.() ?? []), ...declared.keys()])]
  return {
    name: bound ? `${bound.name}+config` : 'weft-manifest',
    intent: (id) => intents.intent(id),
    intents: () => intents.intents(),
    region: async (name) => (await bound?.region?.(name)) ?? declared.get(name),
    regions: () => names,
    /**
     * The catalogue's half, and it is asked in the same order for the same reason: a control plane
     * that can roll a region can roll a renderable, and the generated catalogue is the reviewable
     * fallback underneath it.
     */
    ...(options.renderable
      ? {
          renderable: async (id) => (await bound?.renderable?.(id)) ?? options.renderable?.(id),
          renderables: () => [
            ...new Set([...(bound?.renderables?.() ?? []), ...(options.renderables?.() ?? [])]),
          ],
        }
      : {}),
  }
}
