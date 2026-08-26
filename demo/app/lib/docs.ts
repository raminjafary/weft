/**
 * The docs subtree's content. A page per topic, keyed by the segment that names it.
 *
 * Content rather than configuration, exactly as `showcases.ts` is: the route table is the file tree,
 * and `/docs/:topic` is one route, one plan and one sealed template however many topics there are.
 */
export interface Topic {
  slug: string
  title: string
  summary: string
  paragraphs: readonly string[]
}

export const TOPICS: readonly Topic[] = [
  {
    slug: 'nesting',
    title: 'A document is a chain',
    summary: 'What a nested layout is, and what it deliberately is not.',
    paragraphs: [
      'A route names one document. That document may be a chain: <code>app/layout.tsx</code>, then ' +
        'every <code>layout.tsx</code> in the route’s ancestor directories from the shallowest ' +
        'inwards, then the page. Each link fills the <code>body</code> hole of the layout enclosing it.',
      'The chain is not compiled into one template. Every layer stays a separately sealed, ' +
        'separately versioned fragment, and the cuts each one leaves are spliced together when the ' +
        'document streams — so a slow region inside a nested layout streams exactly as one in the ' +
        'outer document does, in document order, with its own cache policy and its own budget.',
      'Which means the plan does not know it is a chain. Four slots reach it here — two from the ' +
        'application’s document, two from this subtree’s — and nothing downstream of the ' +
        'generator can tell them apart. Nesting is a shape in the file tree, not a second render path.',
    ],
  },
  {
    slug: 'holes',
    title: 'Why the hole names have to differ',
    summary: 'One region cannot be in two places, so a chain may not repeat a name.',
    paragraphs: [
      'A plan keys its slots by name and the client addresses a region by name. If two layers of one ' +
        'chain both left a hole called <code>aside</code>, that would be one region with two places to ' +
        'be — so it is <code>E_DUPLICATE_LAYOUT_HOLE</code>, named at build time with both files in ' +
        'the message.',
      'The one exception is <code>body</code>, which every layer but the innermost uses to hold the ' +
        'next one. That hole never reaches the plan as a slot at all: it is where the chain continues.',
    ],
  },
  {
    slug: 'cache',
    title: 'Every layer is the document',
    summary: 'A nested layout that reads a cookie makes the whole page vary on it.',
    paragraphs: [
      'What a document reads is the union over its chain. A nested layout reading identity makes the ' +
        'document private exactly as the outer layout would, and it takes the page out of the ' +
        'build-time set the same way — the static verdict is computed over every layer, not over the ' +
        'outermost one.',
      'That is why the chain is checked as one fact set rather than layer by layer. Checking the ' +
        'outermost alone would advertise this page as shareable on the strength of a file that is only ' +
        'part of it.',
    ],
  },
]

export function topic(slug: string): Topic | undefined {
  return TOPICS.find((entry) => entry.slug === slug)
}

/** The subtree's table of contents, which is the same on every page under it. */
export function toc(current?: string): string {
  return `<h2 class="hint">In this section</h2><ol>${TOPICS.map(
    (entry) =>
      `<li>${
        entry.slug === current
          ? `<strong>${entry.title}</strong>`
          : `<a href="/docs/${entry.slug}">${entry.title}</a>`
      }</li>`,
  ).join('')}</ol>`
}
