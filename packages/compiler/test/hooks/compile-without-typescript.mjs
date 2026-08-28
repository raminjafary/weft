/**
 * Compiles one fragment with TypeScript hidden, and prints what came out.
 *
 * A child process rather than an in-process hook: the point is what happens at *module load*, and a
 * process that has already loaded the compiler cannot un-load it.
 */
import { compileFiles } from '../../src/compile.ts'

const [file, root] = process.argv.slice(2)
const { modules, diagnostics } = await compileFiles([file], { root })
const entry = modules[0]?.fragments[0]?.entry
process.stdout.write(
  JSON.stringify({
    compiled: Boolean(entry),
    escapes: entry?.holes.map((h) => h.escape) ?? [],
    diagnostics,
  }),
)
