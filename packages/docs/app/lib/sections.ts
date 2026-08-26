/**
 * The sections, and what each one is for.
 *
 * Stated rather than implied, because a documentation site that cannot say which of these a reader
 * wants has to be read in full to be used. The split is the one Vue's docs settled on and it earns
 * its place for the same reason: "how do I start", "how does it work", "walk me through it",
 * "show me", "what is the exact signature", "what does that word mean" and "what does this error
 * mean" are different questions and one page cannot answer all of them well.
 *
 * Three of them are generated from the source and one is computed per request, which is the split
 * worth being able to see on the landing page: a section marked `derived` cannot drift, and the two
 * that are written by hand are the two a reader should hold to a higher standard.
 */
export interface Section {
  href: string
  label: string
  /** One line, shown on the landing page. */
  blurb: string
  /** Whether the section's content is derived from the source rather than written by hand. */
  derived?: boolean
}

export const SECTIONS: readonly Section[] = [
  {
    href: '/quick-start',
    label: 'Quick Start',
    blurb: 'One command, three files, and a page that streams. Ten minutes.',
  },
  {
    href: '/guide',
    label: 'Guide',
    blurb:
      'How it works, in order: fragments, layouts, effects, streaming, the client, intents, live regions, composition, operating it.',
  },
  {
    href: '/tutorial',
    label: 'Tutorial',
    blurb: 'Build one real page from nothing, one step at a time, and watch what each step costs.',
  },
  {
    href: '/examples',
    label: 'Examples',
    blurb: 'Every live example on this site in one place, with its source and what the compiler knows.',
    derived: true,
  },
  {
    href: '/api',
    label: 'API',
    blurb: 'Every export of every package, read out of the source so it cannot drift.',
    derived: true,
  },
  {
    href: '/glossary',
    label: 'Glossary',
    blurb: 'The words this framework uses in a way another framework does not.',
  },
  {
    href: '/errors',
    label: 'Error Reference',
    blurb: 'Every named refusal in the framework, with the message it raises and the file that raises it.',
    derived: true,
  },
  {
    href: '/play',
    label: 'Playground',
    blurb: 'Type a fragment and see what it compiles to. No files, no build — a virtual file set.',
  },
  {
    href: '/search',
    label: 'Search',
    blurb: 'Every page, step, term, error code and export — matched server-side, with nothing to download.',
    derived: true,
  },
]
