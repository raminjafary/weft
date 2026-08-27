import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PAYLOAD_SPEC, PAYLOAD_VERSION, TEMPLATE_IR_SPEC, TEMPLATE_IR_VERSION } from '@weftjs/ir'

/**
 * The versioned artifacts, taken from the constants a build writes.
 *
 * These three numbers are on the wire, which is exactly why the page must not quote them: a table
 * somebody keeps in step with the code is a table that is one commit behind whenever it matters.
 * Two of them are imported — they are the values this process would stamp on a document — and the
 * warp figure is read out of `packages/warp/src/version.ts`, because nothing on this site speaks
 * warp and depending on it to render a table would be a dependency for a sentence.
 *
 * The summary table in `spec/VERSIONING.md` was one minor behind the source when this page was
 * written. That is the argument for generating it, made by the thing it happened to.
 */
export interface Artifact {
  what: string
  /** The format name. A different name is a different format, not a version. */
  spec: string
  version: string
  /** The package that is the reference implementation. */
  reference: string
}

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

function fromSource(file: string, name: string): string {
  const source = readFileSync(join(ROOT, file), 'utf8')
  const match = new RegExp(`export const ${name} = '([^']+)'`).exec(source)
  if (!match) throw new Error(`E_DOCS_NO_VERSION: ${file} no longer exports ${name}`)
  return match[1] as string
}

export function artifacts(): Artifact[] {
  return [
    {
      what: 'Template IR',
      spec: TEMPLATE_IR_SPEC,
      version: TEMPLATE_IR_VERSION,
      reference: 'packages/ir',
    },
    {
      what: 'Payloads',
      spec: PAYLOAD_SPEC,
      version: PAYLOAD_VERSION,
      reference: 'packages/ir',
    },
    {
      what: 'Warp frames',
      spec: fromSource('packages/warp/src/version.ts', 'WARP_SPEC'),
      version: fromSource('packages/warp/src/version.ts', 'WARP_VERSION'),
      reference: 'packages/warp',
    },
  ]
}
