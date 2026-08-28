import type { Block } from '../fragments/docs/page.tsx'
import type { Cell } from '../fragments/docs/table.tsx'
import { highlight } from './highlight.ts'

/**
 * Blocks, as the builders that used to concatenate strings now produce them.
 *
 * One constructor per block kind, each filling the fields its arm reads and leaving the rest empty.
 * A row has one template, so every block carries every field — writing that out at 40 call sites is
 * what these functions exist to avoid.
 *
 * The order of the arms in `docs/page.tsx` is the order of the flags here, and nothing enforces the
 * agreement beyond both being small and in one file each. A block with no flag set falls through to
 * the bespoke arm, which is the honest default: an unrecognised block renders its `html` rather than
 * rendering nothing.
 */

const EMPTY: Block = {
  kind: 'bespoke',
  isProse: false,
  isHeading: false,
  isNote: false,
  isTable: false,
  isFigure: false,
  isOption: false,
  paragraphs: [],
  text: '',
  id: '',
  noteKind: '',
  title: '',
  body: '',
  headers: [],
  rows: [],
  caption: '',
  code: '',
  lang: '',
  sketch: false,
  html: '',
  name: '',
  optionType: '',
  fallback: '',
  requirement: '',
  hasMembers: '',
  example: '',
  hasExample: '',
}

/** Paragraphs of authored prose. The inline markup is this repository's, and travels as it is. */
export function prose(...paragraphs: string[]): Block {
  return { ...EMPTY, kind: 'prose', isProse: true, paragraphs: paragraphs.map((html) => ({ html })) }
}

/** A section heading with its anchor. The text is a value, so it escapes. */
export function heading(text: string, id: string): Block {
  return { ...EMPTY, kind: 'heading', isHeading: true, text, id }
}

export function note(kind: 'why' | 'refused' | 'careful', title: string, body: string): Block {
  return { ...EMPTY, kind: 'note', isNote: true, noteKind: kind, title, body }
}

/**
 * A table. This is the block that carries data, and the reason the conversion was worth doing.
 *
 * Its cells hold error codes, file paths, messages extracted from source and exported signatures —
 * values, escaped by the compiler. The `table()` it replaced took pre-built HTML, so each of its
 * call sites assembled its own `<a>` and `<code>` and escaped what went inside, or did not.
 */
export function table(headers: readonly string[], rows: readonly (readonly Cell[])[]): Block {
  return {
    ...EMPTY,
    kind: 'table',
    isTable: true,
    headers: [...headers],
    rows: rows.map((cells) => ({ cells: [...cells] })),
  }
}

/** A code block, highlighted here so the block carries markup the template can trust. */
export function figure(lang: string, source: string, caption: string): Block {
  return {
    ...EMPTY,
    kind: 'figure',
    isFigure: true,
    caption,
    lang,
    code: highlight(lang, source.trim()),
  }
}

/** A sketch: quoted, never compiled, and the caption says so. */
export function sketch(lang: string, source: string): Block {
  return { ...figure(lang, source, 'sketch — not compiled'), kind: 'sketch' }
}

/**
 * One reference entry: a field, what it accepts, what it is without you, and why.
 *
 * The doc paragraphs arrive already escaped with backticks turned into `<code>` — see `docHtml` in
 * `declared.ts`. Everything else is a value and the compiler escapes it.
 */
export function option(entry: {
  name: string
  id: string
  type: string
  fallback: string
  required: boolean
  paragraphs: readonly string[]
  members?: readonly (readonly Cell[])[]
  /** A line or two showing the shape. Highlighted here, so the block carries markup to trust. */
  example?: string
}): Block {
  const members = entry.members ?? []
  return {
    ...EMPTY,
    kind: 'option',
    isOption: true,
    name: entry.name,
    id: entry.id,
    optionType: entry.type,
    fallback: entry.fallback,
    requirement: entry.required ? 'required' : 'optional',
    paragraphs: entry.paragraphs.map((html) => ({ html })),
    headers: members.length ? ['Field', 'Type', 'Default'] : [],
    rows: members.map((cells) => ({ cells: [...cells] })),
    hasMembers: members.length ? 'yes' : '',
    example: entry.example ? highlight('ts', entry.example.trim()) : '',
    hasExample: entry.example ? 'yes' : '',
  }
}

/**
 * Markup this set has no block for.
 *
 * Deliberately named rather than hidden inside a helper, so a page still building its own markup is
 * visible in a diff. The examples showcase is the remaining user: it is three panels and two facts
 * tables, and it wants a component of its own rather than a block flag.
 */
export function bespoke(html: string): Block {
  return { ...EMPTY, kind: 'bespoke', html }
}

/** Cell constructors, so a call site says what a cell is rather than assembling one. */
export const cell = {
  text: (text: string): Cell => ({ text, href: '', code: false, hint: false }),
  code: (text: string): Cell => ({ text, href: '', code: true, hint: false }),
  hint: (text: string): Cell => ({ text, href: '', code: false, hint: true }),
  link: (text: string, href: string): Cell => ({ text, href, code: false, hint: false }),
  /** A link whose text is code: an error code linking to its own page is both. */
  codeLink: (text: string, href: string): Cell => ({ text, href, code: true, hint: false }),
}
