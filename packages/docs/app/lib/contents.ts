import type { ContentsGroup } from '../fragments/docs/contents.tsx'
import { surface } from './surface.ts'
import { PARTS, STEPS } from './tutorial.ts'
import { errorsByPackage, errorByCode } from './errors.ts'
import { TERMS, slug } from './glossary.ts'
import { GROUPS, PAGES } from './pages.ts'
import { fieldCount, REFERENCES } from './reference.ts'
import { conventionRows } from './conventions.ts'
import { ports } from './ports.ts'

/**
 * The values behind `fragments/docs/contents.tsx`, one function per section. Loaders, not markup
 * builders — they return data through a template hole, so escaping is the compiler's decision, not
 * a hand-called `escapeHtml` somebody could forget.
 */

/** `aria-current`'s two values, so no call site spells them. */
const HERE = 'page'
const ELSEWHERE = 'false'

/** The rail, with the index itself as its first entry — `/guide` is a page, not only a directory, so a reader four pages in has a way back to the diagrams. */
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

/** Every term, under the letter it starts with. Letters are the group labels, not a row of chips above — only letters with a term appear. */
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

/** The gallery's rail: examples under the guide's own groups (not a flat page list), since the question is "show me the rendering ones", not "page eleven". */
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

/** Every package with its count, and the codes of the one you're in. Two groups, not nine — counts do the work nine single-row headings used to. */
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

  // Only the current package opens. See bc31dd5: all 326 codes in every column made the nav 87% of each of 327 files.
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

/** The rail on the two pages not in a section: Quick Start and the playground. Deliberately short — the other two ways in, plus a few guide pages, not all twenty-two. */
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

/** The API reference's rail: every package, with how many names it exports. Was a hand-built `<ul>` until it drifted from the site's other sealed-template rails. */
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

/** The tutorial's rail: steps under their parts, ones behind you ticked. `count` leads the title — the one place on this site where that's true, since titles alone don't say "where am I". */
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

/** The reference's rail: what you write, with how many fields each has — the number that actually helps decide which page to open. */
export function referenceContents(current?: string): ContentsGroup[] {
  return [
    {
      label: 'What you write',
      items: [
        {
          label: 'All references',
          href: '/reference',
          count: String(REFERENCES.length),
          current: current === undefined ? HERE : ELSEWHERE,
        },
        ...REFERENCES.map((reference) => ({
          label: reference.label,
          href: `/reference/${reference.id}`,
          count: String(
            reference.kind === 'declaration'
              ? fieldCount(reference)
              : reference.kind === 'ports'
                ? ports().length
                : conventionRows().length,
          ),
          current: reference.id === current ? HERE : ELSEWHERE,
        })),
      ],
    },
  ]
}
