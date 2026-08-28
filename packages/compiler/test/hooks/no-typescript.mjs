/**
 * A resolver that behaves as though TypeScript were not installed.
 *
 * Which is the environment the compiler's optional peer promises to work in, and the one nothing
 * tested: `npm create weft` installs no optional peer, and every checkout that runs these tests has
 * TypeScript in the workspace root — so a static import of it was satisfied here and absent there.
 */
export async function resolve(specifier, context, next) {
  if (specifier === 'typescript' || specifier.startsWith('typescript/')) {
    const error = new Error(`Cannot find package 'typescript' (this resolver hid it)`)
    error.code = 'ERR_MODULE_NOT_FOUND'
    throw error
  }
  return next(specifier, context)
}
