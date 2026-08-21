import { cp, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The framework's own `.tsx` and `.css` are data, not code: the compiler reads them and the
 * server serves them. `tsc` has no reason to know about them, so they are copied.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const from = join(root, 'packages/weft/src/assets')
const to = join(root, 'packages/weft/dist/assets')
await mkdir(to, { recursive: true })
await cp(from, to, { recursive: true })
process.stdout.write(`copied assets to ${to}\n`)
