import type { ProvProps } from '../fragments/docs/prov.tsx'
import { errorByCode, errorCodes, errorsByPackage } from './errors.ts'
import { TERMS } from './glossary.ts'
import { PAGES } from './pages.ts'

/**
 * The values behind `fragments/docs/prov.tsx`, one function per outline column.
 *
 * Each returns `Record<string, unknown>` with `satisfies ProvProps` behind it, which is the pairing
 * a loader needs: a fragment's props travel as values, so a slot's `load` has to return something
 * value-shaped, and a named interface has no index signature to be that. `satisfies` keeps every
 * field checked against the component without widening what the loader promises.
 *
 * These replaced three hand-built `<dl class="prov">` strings in `errors-page.ts`, `gallery.ts` and
 * `glossary.ts` — the same markup three times, each escaping its own values or not. They return data
 * now, so the escaping is the compiler's and the markup exists once.
 */

const fact = (label: string, value: string, options: { href?: string; code?: boolean } = {}) => ({
  label,
  value,
  href: options.href ?? '',
  code: options.code ?? false,
})

/** No closing link. Spelled once so the three callers that have none do not each say it. */
const NO_MORE = { moreHref: '', moreLabel: '' }

export function errorsOutline(code?: string): Record<string, unknown> {
  const entry = code ? errorByCode(code) : undefined
  if (!entry) {
    const all = errorCodes()
    return {
      heading: 'This page',
      facts: [
        fact('Codes', String(all.length)),
        fact('Packages', String(errorsByPackage().length)),
        fact('With a spec reference', String(all.filter((one) => one.spec.length).length)),
      ],
      ...NO_MORE,
    } satisfies ProvProps
  }
  return {
    heading: 'This code',
    facts: [
      fact('Package', entry.package, { code: true }),
      fact('Raised at', `${entry.sites.length} site${entry.sites.length === 1 ? '' : 's'}`),
      fact('Specified in', String(entry.spec.length || '—')),
    ],
    moreHref: '/errors',
    moreLabel: 'All codes',
  } satisfies ProvProps
}

export function galleryOutline(): Record<string, unknown> {
  const pages = PAGES.filter((page) => page.examples.length)
  const total = pages.reduce((sum, page) => sum + page.examples.length, 0)
  return {
    heading: 'This page',
    facts: [
      fact('Examples', String(total)),
      fact('From', `${pages.length} guide page${pages.length === 1 ? '' : 's'}`),
      fact('Source', 'app/fragments/examples/', { code: true }),
    ],
    moreHref: '/guide',
    moreLabel: 'The guide these are from',
  } satisfies ProvProps
}

export function glossaryOutline(): Record<string, unknown> {
  const targets = new Set(TERMS.flatMap((term) => (term.see ?? []).map((link) => link.href)))
  return {
    heading: 'This page',
    facts: [
      fact('Terms', String(TERMS.length)),
      fact('Pointing at', `${targets.size} page${targets.size === 1 ? '' : 's'}`),
    ],
    moreHref: '/guide',
    moreLabel: 'The guide these words are used in',
  } satisfies ProvProps
}
