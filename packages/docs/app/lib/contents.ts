import type { ContentsGroup } from '../fragments/docs/contents.tsx'
import { errorsByPackage, errorByCode } from './errors.ts'
import { TERMS, slug } from './glossary.ts'
import { GROUPS, PAGES } from './pages.ts'

/**
 * The values behind `fragments/docs/contents.tsx`, one function per section.
 *
 * These are loaders rather than markup builders, which is the difference that matters: they return
 * data, the template turns it into bytes, and nothing here can emit a tag. The four string builders
 * they replaced each hand-escaped their own labels, and a missed `escapeHtml` in any of them was an
 * injection — a term, a page title or an error code goes through a hole now, so escaping is the
 * compiler's decision and not a call somebody has to remember.
 */

/** `aria-current`'s two values, so no call site spells them. */
const HERE = 'page'
const ELSEWHERE = 'false'

export function guideContents(current?: string): ContentsGroup[] {
  return GROUPS.map((group) => ({
    label: group.label,
    items: PAGES.filter((page) => page.group === group.id).map((page) => ({
      label: page.title,
      href: `/guide/${page.slug}`,
      count: '',
      current: page.slug === current ? HERE : ELSEWHERE,
    })),
  })).filter((group) => group.items.length > 0)
}

export function glossaryContents(): ContentsGroup[] {
  return [
    {
      label: 'Terms',
      items: TERMS.map((term) => ({
        label: term.term,
        href: `#${slug(term.term)}`,
        count: '',
        current: ELSEWHERE,
      })),
    },
  ]
}

export function galleryContents(): ContentsGroup[] {
  return [
    {
      label: 'By page',
      items: PAGES.filter((page) => page.examples.length).map((page) => ({
        label: page.title,
        href: `#${page.slug}`,
        count: String(page.examples.length),
        current: ELSEWHERE,
      })),
    },
  ]
}

/**
 * Every package, with only the one holding the current code opened.
 *
 * The reason is in bc31dd5: all 326 codes in every column made the nav 87% of each of 327 files, and
 * a 326-item list is not something anybody navigates. A closed package is a group whose single item
 * is the package itself, which is what keeps this expressible without a conditional in the template.
 */
export function errorsContents(current?: string): ContentsGroup[] {
  const here = current ? errorByCode(current)?.package : undefined
  return errorsByPackage().map((group) => {
    if (group.package !== here) {
      return {
        label: group.package,
        items: [
          {
            label: `${group.codes.length} codes`,
            href: `/errors#p-${group.package}`,
            count: '',
            current: ELSEWHERE,
          },
        ],
      }
    }
    return {
      label: group.package,
      items: group.codes.map((entry) => ({
        label: entry.code,
        href: `/errors/${encodeURIComponent(entry.code)}`,
        count: '',
        current: entry.code === current ? HERE : ELSEWHERE,
      })),
    }
  })
}
