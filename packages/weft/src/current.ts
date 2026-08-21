import type { AssetTable } from './assets.ts'
import type { CompiledApp, CompiledFragment } from './compile.ts'

/**
 * The running application, for the two helpers that genuinely need it.
 *
 * A process serves one application, so this is a fact rather than a convenience: `asset()` has
 * to answer with a URL that carries the digest of a file the build hashed, and a loader calling
 * it has no other way to reach that table. It is set once, when the app is created, and read
 * only from inside a render — which is why a missing app here is a bug in the framework rather
 * than something an application can cause.
 */
let assets: AssetTable | null = null
let compiled: CompiledApp | null = null

export function setAssets(table: AssetTable): void {
  assets = table
}

export function setCompiled(app: CompiledApp): void {
  compiled = app
}

/**
 * A compiled fragment, by the name the convention gave it.
 *
 * `fragmentIR('card')` is `app/fragments/card.tsx`; `fragmentIR('layout')` is the document. This
 * is the framework's own table rather than a second compilation, which is the only version worth
 * exposing: a page that reads a hole, a read set or an escape decision here is reading the one the
 * renderer beside it used, so the two cannot disagree.
 */
export function fragmentIR(name: string): CompiledFragment {
  if (!compiled) throw new Error(`E_NO_APP: fragmentIR(${name}) was called outside a running application`)
  const found =
    compiled.fragments[name] ??
    compiled.fragments[`fragment:${name}`] ??
    compiled.fragments[`route:${name}`] ??
    compiled.fragments[`layout:${name}`] ??
    compiled.fragments[`slot:${name}`]
  if (!found) {
    throw new Error(
      `E_NO_FRAGMENT: '${name}' is not a compiled fragment. Known: ${Object.keys(compiled.fragments).join(', ')}`,
    )
  }
  return found
}

/**
 * Every compiled fragment, by the name the convention gave it.
 *
 * For a page whose subject is the application rather than a part of it — a coverage table, a
 * count of sealed templates, a validator run over every fragment's facts. Reaching for one
 * fragment is `fragmentIR`; this is for the questions that are about all of them.
 */
export function allFragments(): Record<string, CompiledFragment> {
  if (!compiled) throw new Error('E_NO_APP: allFragments() was called outside a running application')
  return compiled.fragments
}

/** Every sealed template the application has, for a page that wants to count them. */
export function allTemplates(): CompiledApp['templates'] {
  if (!compiled) throw new Error('E_NO_APP: allTemplates() was called outside a running application')
  return compiled.templates
}

/**
 * A file from `public/`, by the path you wrote it at.
 *
 * The URL comes back with a digest of the file's contents in it, so it can be cached for a year
 * — which is the entire reason to call this rather than writing the path by hand. An unknown
 * path throws: a typo should fail the render that made it, not become a 404 nobody notices
 * until it is in production.
 */
export function asset(path: string): string {
  if (!assets) throw new Error(`E_NO_APP: asset(${path}) was called outside a running application`)
  return assets.asset(path)
}
