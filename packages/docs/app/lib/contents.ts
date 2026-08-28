import type { ContentsGroup } from '../fragments/docs/contents.tsx'
import { surface } from './surface.ts'
import { PARTS, STEPS } from './tutorial.ts'
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

/**
 * The rail, with the index itself as its first entry.
 *
 * `/guide` is a page and not only a directory — it opens with the architecture — so it belongs in
 * the list of pages rather than only above it. Without the entry a reader on page four has no way
 * back to the diagrams except the breadcrumb, which reads as a way out of the guide.
 */
export function guideContents(current?: string): ContentsGroup[] {
  const groups = GROUPS.map((group) => ({
    label: group.label,
    items: PAGES.filter((page) => page.group === group.id).map((page) => ({
      label: page.title,
      href: `/guide/${page.slug}`,
      count: '',
      current: page.slug === current ? HERE : ELSEWHERE,
    })),
  })).filter((group) => group.items.length > 0)
  groups[0]?.items.unshift({
    label: 'Architecture — the whole framework',
    href: '/guide',
    count: '',
    current: current === undefined ? HERE : ELSEWHERE,
  })
  return groups
}

/**
 * Every term, under the letter it starts with.
 *
 * The letters are the group labels rather than a row of chips above the terms, which is what this
 * page used to carry in its body — an index of thirty-six words wants both halves in one column,
 * and a reader who knows the word they want should not have to jump to a letter and then read down
 * from it. Only the letters with a term under them appear, because they are made from the terms.
 */
export function glossaryContents(): ContentsGroup[] {
  const letters = [...new Set(TERMS.map((term) => term.term.slice(0, 1).toUpperCase()))].toSorted()
  return letters.map((letter) => ({
    label: letter,
    items: TERMS.filter((term) => term.term.slice(0, 1).toUpperCase() === letter).map((term) => ({
      label: term.term,
      href: `#${slug(term.term)}`,
      count: '',
      current: ELSEWHERE,
    })),
  }))
}

/**
 * The gallery's rail: the examples, under the part of the framework they belong to.
 *
 * Grouped by the guide's own groups rather than as one flat list of pages, because the question a
 * reader has here is "show me the rendering ones" and not "show me the ones from page eleven". The
 * total leads, so the page says how many there are before it says where they are.
 */
export function galleryContents(): ContentsGroup[] {
  const shown = PAGES.filter((page) => page.examples.length)
  const total = shown.reduce((sum, page) => sum + page.examples.length, 0)
  const groups = GROUPS.map((group) => {
    const pages = shown.filter((page) => page.group === group.id)
    return {
      label: group.label,
      items: pages.map((page) => ({
        label: page.title,
        href: `#${page.slug}`,
        count: String(page.examples.length),
        current: ELSEWHERE,
      })),
    }
  }).filter((group) => group.items.length > 0)
  return [
    {
      label: 'Everything',
      items: [{ label: 'All examples', href: '#all', count: String(total), current: ELSEWHERE }],
    },
    ...groups,
  ]
}

/**
 * Every package with its count, and the codes of the one you are in.
 *
 * Two groups rather than nine: where a refusal is raised, then the package holding this code. The
 * counts do the work the nine headings used to — a rail whose every group held the single row
 * "30 codes" was spending a heading to say a number, and putting it nowhere the eye looks for one.
 */
export function errorsContents(current?: string): ContentsGroup[] {
  const here = current ? errorByCode(current)?.package : undefined
  const packages = errorsByPackage()
  const total = packages.reduce((sum, group) => sum + group.codes.length, 0)

  const where: ContentsGroup = {
    label: 'Where it is raised',
    items: [
      { label: 'All', href: '/errors', count: String(total), current: current ? ELSEWHERE : HERE },
      ...packages.map((group) => ({
        label: group.package,
        href: `/errors#p-${group.package}`,
        count: String(group.codes.length),
        current: ELSEWHERE,
      })),
    ],
  }

  if (!here) return [where]

  // Only the package holding the current code is opened. The reason is in bc31dd5: all 326 codes in
  // every column made the nav 87% of each of 327 files, and a 326-item list is not something
  // anybody navigates.
  const open = packages.find((group) => group.package === here)
  return [
    where,
    ...(open
      ? [
          {
            label: open.package,
            items: open.codes.map((entry) => ({
              label: entry.code,
              href: `/errors/${encodeURIComponent(entry.code)}`,
              count: '',
              current: entry.code === current ? HERE : ELSEWHERE,
            })),
          },
        ]
      : []),
  ]
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
 * The tutorial's rail: the steps under their parts, with the ones behind you marked.
 *
 * `count` carries the step's number, or a tick where you have already read it — and it leads the
 * title rather than trailing it, which is the one place on this site where that is true. Nineteen
 * titles of very different lengths need something to align against, and "where am I" is answered
 * by the number and the part rather than by the title, which no longer carries a number of its own.
 */
export function tutorialContents(current?: string): ContentsGroup[] {
  const at = STEPS.findIndex((step) => step.slug === current)
  return PARTS.map((part) => ({
    label: part.label,
    items: STEPS.filter((step) => step.part === part.id).map((step) => ({
      label: step.title,
      href: `/tutorial/${step.slug}`,
      count: at >= 0 && STEPS.indexOf(step) < at ? '✓' : String(STEPS.indexOf(step) + 1),
      current: step.slug === current ? HERE : ELSEWHERE,
    })),
  })).filter((group) => group.items.length > 0)
}
