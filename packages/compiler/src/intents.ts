import { fastHash } from '@weft/ir'

/**
 * An intent id is opaque and derived from the module and export it came from, so the
 * client never carries the name of server code and renaming an export does not change
 * the wire. Changing which module an intent lives in does change it, deliberately.
 */
export function intentId(module: string, exportName: string): string {
  return fastHash(`${module}#${exportName}`).slice(0, 6)
}
