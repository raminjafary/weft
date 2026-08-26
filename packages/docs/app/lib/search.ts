import { errorCodes } from './errors.ts'
import { escapeHtml, note, prose, table } from './markup.ts'
import { headingsOf } from './content.ts'
import { PAGES } from './pages.ts'
import { SECTIONS } from './sections.ts'
import { slug as termSlug, TERMS } from './glossary.ts'
import { STEPS } from './tutorial.ts'
import { surface } from './surface.ts'

/**
 * Search, as a route rather than as a script.
 *
 * Every documentation site of this size needs one, and the usual answer is a prebuilt index and a
 * client-side matcher — which is a second copy of the content, shipped to every reader, whether or
 * not they search. This is a form with `method="get"`: the query is a parameter, so a result page
 * has a URL somebody can send to a colleague, it works with JavaScript switched off, and the index
 * is the site's own registries rather than a build artifact that can disagree with them.
 *
 * Reading the parameter taints `route:q`, which makes each query its own cache entry. That is the
 * right behaviour for a pure function of the query, and it is the same shape the playground has.
 */
export type ResultKind = 'section' | 'guide' | 'heading' | 'tutorial' | 'term' | 'error' | 'api'

export interface Result {
  kind: ResultKind
  title: string
  href: string
  /** One line of context, already escaped where it came from user input. */
  detail: string
  /** Higher is better. Ordering only; not shown. */
  score: number
}

interface Candidate {
  kind: ResultKind
  title: string
  href: string
  detail: string
  /** What the query is matched against, lowercased once. */
  haystack: string
  /** Ties broken toward the sections a reader is more likely to want. */
  weight: number
}

const WEIGHT: Record<ResultKind, number> = {
  guide: 6,
  section: 5,
  term: 4,
  tutorial: 4,
  heading: 3,
  api: 2,
  error: 2,
}

function candidates(): Candidate[] {
  const out: Candidate[] = []

  for (const section of SECTIONS) {
    out.push({
      kind: 'section',
      title: section.label,
      href: section.href,
      detail: section.blurb,
      haystack: `${section.label} ${section.blurb}`.toLowerCase(),
      weight: WEIGHT.section,
    })
  }

  for (const page of PAGES) {
    out.push({
      kind: 'guide',
      title: page.title,
      href: `/guide/${page.slug}`,
      detail: page.lede,
      haystack: `${page.title} ${page.lede} ${page.slug}`.toLowerCase(),
      weight: WEIGHT.guide,
    })
    for (const heading of headingsOf(page.slug)) {
      out.push({
        kind: 'heading',
        title: heading.text,
        href: `/guide/${page.slug}#${heading.id}`,
        detail: `In ${page.title}`,
        haystack: `${heading.text} ${page.title}`.toLowerCase(),
        weight: WEIGHT.heading,
      })
    }
  }

  for (const step of STEPS) {
    out.push({
      kind: 'tutorial',
      title: step.title,
      href: `/tutorial/${step.slug}`,
      detail: step.lede,
      haystack: `${step.title} ${step.lede}`.toLowerCase(),
      weight: WEIGHT.tutorial,
    })
  }

  for (const term of TERMS) {
    out.push({
      kind: 'term',
      title: term.term,
      href: `/glossary#${termSlug(term.term)}`,
      detail: term.short,
      haystack: `${term.term} ${term.short}`.toLowerCase(),
      weight: WEIGHT.term,
    })
  }

  for (const code of errorCodes()) {
    out.push({
      kind: 'error',
      title: code.code,
      href: `/errors/${code.code}`,
      detail: code.message || `Raised in ${code.package}`,
      haystack: `${code.code} ${code.message}`.toLowerCase(),
      weight: WEIGHT.error,
    })
  }

  for (const module of surface()) {
    for (const entry of module.entries) {
      out.push({
        kind: 'api',
        title: entry.name,
        href: `/api/${module.id}#${entry.name}`,
        detail: `${entry.kind} in ${module.specifier}`,
        haystack: `${entry.name} ${module.specifier} ${entry.kind}`.toLowerCase(),
        weight: WEIGHT.api,
      })
    }
  }

  return out
}

/**
 * Score one candidate against a query.
 *
 * Deliberately simple, and simple here means explainable: an exact title, then a title prefix, then
 * a title substring, then a hit anywhere in the text. A relevance function nobody can predict is a
 * search box people stop trusting after the second surprising result.
 */
function score(candidate: Candidate, needles: string[]): number {
  const title = candidate.title.toLowerCase()
  let total = 0
  for (const needle of needles) {
    if (title === needle) total += 100
    else if (title.startsWith(needle)) total += 60
    else if (title.includes(needle)) total += 40
    else if (candidate.haystack.includes(needle)) total += 15
    else return 0
  }
  return total + candidate.weight
}

export function search(query: string, limit = 60): Result[] {
  const needles = query
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 1)
  if (!needles.length) return []

  return candidates()
    .map((candidate) => ({ candidate, points: score(candidate, needles) }))
    .filter((scored) => scored.points > 0)
    .sort((a, b) => b.points - a.points || a.candidate.title.length - b.candidate.title.length)
    .slice(0, limit)
    .map(({ candidate, points }) => ({
      kind: candidate.kind,
      title: candidate.title,
      href: candidate.href,
      detail: candidate.detail,
      score: points,
    }))
}

const LABEL: Record<ResultKind, string> = {
  section: 'Sections',
  guide: 'Guide pages',
  heading: 'Sections of a guide page',
  tutorial: 'Tutorial steps',
  term: 'Glossary',
  error: 'Error codes',
  api: 'API',
}

/**
 * The order results are shown in, and it is not the score order.
 *
 * Grouped by where the answer lives, prose before reference — because a search for "delta" should
 * put the page that explains deltas above the eleven exported symbols whose names begin with it.
 * Ranking those against each other on one scale is a fight that has no right answer; saying which
 * kind of answer usually helps first does.
 */
const ORDER: ResultKind[] = ['guide', 'heading', 'section', 'tutorial', 'term', 'error', 'api']

/** Reference sections are capped, because forty symbols is a listing rather than an answer. */
const SHOWN: Partial<Record<ResultKind, number>> = { api: 10, error: 10, heading: 8 }

/** How much there is to search, so the empty state says something true rather than nothing. */
export function indexSize(): number {
  return candidates().length
}

/**
 * The search box, on the results page, carrying the query that produced them.
 *
 * The header's copy lives in `app/layout.tsx` and cannot be pre-filled: `layoutValues` is handed the
 * route's params and `q` is a query parameter, so a shared document hole has no way to read it. The
 * result was a page that showed "52 results for fragment" above an empty box — so refining a search
 * meant retyping it, and the box you had just typed into looked like it had thrown the input away.
 *
 * This one is inside the slot that *did* read `?q`, which is the one place on the page that knows.
 */
function searchAgain(query: string): string {
  return (
    `<form class="find find-again" method="get" action="/search" role="search">` +
    `<input type="search" name="q" value="${escapeHtml(query)}" placeholder="Search" ` +
    `aria-label="Search this site" autofocus>` +
    `<button type="submit">Search</button>` +
    `</form>`
  )
}

export function searchBody(query: string): string {
  const trimmed = query.trim()
  if (!trimmed) {
    return (
      prose(
        `Every guide page, tutorial step, glossary entry, error code and exported name — ${indexSize()} ` +
          'things — matched against what you type. Nothing is downloaded to do it: this is a form with ' +
          '<code>method="get"</code>, so a search has a URL and works with the runtime switched off.',
      ) +
      note(
        'why',
        'Why a route and not a script',
        'A prebuilt search index is a second copy of the content, shipped to every reader whether they ' +
          'search or not. This one is the site’s own registries — the same objects the guide, the ' +
          'glossary and the generated references are rendered from — so a result cannot point at ' +
          'something that has been renamed.',
      )
    )
  }

  const results = search(trimmed)
  if (!results.length) {
    return (
      searchAgain(trimmed) +
      prose(
        `Nothing matches <strong>${escapeHtml(trimmed)}</strong>.`,
        'Error codes are searchable by their name, so <code>E_NO_SHELL</code> finds its page. Exported ' +
          'names are searchable exactly. If you are looking for a concept and not a word, the ' +
          '<a href="/glossary">glossary</a> is short enough to read.',
      )
    )
  }

  const groups = ORDER.map((kind) => {
    const hits = results.filter((result) => result.kind === kind)
    if (!hits.length) return ''
    const cap = SHOWN[kind] ?? hits.length
    const shown = hits.slice(0, cap)
    const more =
      hits.length > shown.length
        ? `<p class="hint">and ${hits.length - shown.length} more in this section.</p>`
        : ''
    return (
      `<h2>${LABEL[kind]}</h2>` +
      table(
        ['What', 'Why it matched'],
        shown.map((result) => [
          `<a href="${result.href}">${escapeHtml(result.title)}</a>`,
          escapeHtml(result.detail),
        ]),
      ) +
      more
    )
  }).join('')

  return (
    searchAgain(trimmed) +
    prose(
      `${results.length} result${results.length === 1 ? '' : 's'} for ` +
        `<strong>${escapeHtml(trimmed)}</strong>, grouped by where the answer lives.`,
    ) +
    groups
  )
}
