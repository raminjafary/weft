import type { ContentsGroup } from '../fragments/docs/contents.tsx'
import { surface } from './surface.ts'
import { STEPS } from './tutorial.ts'
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

/**
 * The rail on the two pages that are not in a section: Quick Start, and the playground beside it.
 *
 * It is deliberately short. Somebody on Quick Start has not chosen a section yet, so the useful
 * thing beside them is the other two ways in and the first few pages of the guide — not the whole
 * twenty-two, which is what the guide's own rail is for.
 */
export function startContents(current: string): ContentsGroup[] {
  const here = (href: string) => (href === current ? HERE : ELSEWHERE)
  return [
    {
      label: 'Getting started',
      items: [
        { label: 'Quick Start', href: '/quick-start', count: '', current: here('/quick-start') },
        { label: 'Tutorial', href: '/tutorial', count: '', current: here('/tutorial') },
        { label: 'Playground', href: '/play', count: '', current: here('/play') },
      ],
    },
    {
      label: 'Guide · start here',
      items: PAGES.slice(0, 4).map((page) => ({
        label: page.title,
        href: `/guide/${page.slug}`,
        count: '',
        current: ELSEWHERE,
      })),
    },
  ]
}

/**
 * The API reference's rail: every package, with how many names it exports.
 *
 * It was a hand-built `<ul>` until the rest of the site's rails became one sealed template — which
 * is the argument for a component made by the thing that happened next: its markup drifted, and the
 * stylesheet beside the fragment was not linked on the one page that did not render it.
 */
export function apiContents(current?: string): ContentsGroup[] {
  return [
    {
      label: 'Packages',
      items: surface().map((module) => ({
        label: module.specifier,
        href: `/api/${module.id}`,
        count: String(module.entries.length),
        current: module.id === current ? HERE : ELSEWHERE,
      })),
    },
  ]
}

/**
 * The tutorial's rail: the six steps, with the ones behind you marked.
 *
 * `count` carries the tick rather than the step number, because a step you have read is the one
 * fact a reader wants from this column at a glance.
 */
export function tutorialContents(current?: string): ContentsGroup[] {
  const at = STEPS.findIndex((step) => step.slug === current)
  return [
    {
      label: 'Tutorial',
      items: STEPS.map((step, index) => ({
        label: step.title,
        href: `/tutorial/${step.slug}`,
        count: at >= 0 && index < at ? '✓' : '',
        current: step.slug === current ? HERE : ELSEWHERE,
      })),
    },
  ]
}
