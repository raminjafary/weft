import { fastHash } from '@weftjs/ir'

/** Opaque, derived from the module and export it came from. See `spec/kernel/intents.md`. */
export function intentId(module: string, exportName: string): string {
  return fastHash(`${module}#${exportName}`).slice(0, 6)
}
