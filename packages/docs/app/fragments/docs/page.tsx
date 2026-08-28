import { fragment, raw } from '@weftjs/core'
import Note from './note.tsx'
import Option from './option.tsx'
import Table from './table.tsx'
import type { Cell } from './table.tsx'

/**
 * One block of a page body. Every field is present on every block, because a row has one template.
 *
 * The flags decide which arm renders and the rest go unused, which is the cost of a heterogeneous
 * list in a sealed template: the alternative is a hole per block kind in a fixed order, and a page
 * body is not a fixed order. Unused fields are empty and compress to nothing.
 */
export interface Block {
  kind: string
  isProse: boolean
  isHeading: boolean
  isNote: boolean
  isTable: boolean
  isFigure: boolean
  isOption: boolean
  /** Paragraphs, each carrying authored inline markup. See the note on `raw` below. */
  paragraphs: { html: string }[]
  text: string
  id: string
  noteKind: string
  title: string
  body: string
  headers: string[]
  rows: { cells: Cell[] }[]
  caption: string
  code: string
  lang: string
  sketch: boolean
  /** The escape hatch, named so it is visible in a diff rather than hiding inside a helper. */
  html: string
  /**
   * The reference entry's own fields. `id`, `paragraphs`, `headers` and `rows` are shared with the
   * blocks above it, which is the whole reason a block carries every field: an option is a heading,
   * some prose and a table, and it should not need four of its own.
   */
  name: string
  optionType: string
  fallback: string
  requirement: string
  /** Non-empty draws the nested member table. A hole is filled, never branched on. */
  hasMembers: string
  /** The entry's own example, already highlighted. Non-empty `hasExample` draws it. */
  example: string
  hasExample: string
}

export interface PageProps {
  blocks: Block[]
}

/**
 * A page body, as one sealed template over a list of typed blocks.
 *
 * This is what replaced string concatenation in the body builders, and the shape of the replacement
 * was decided by counting: there are 179 inline tags — `<code>`, `<strong>`, `<a href>`, `<em>` —
 * inside the prose on this site. So prose is not UI and is not converted to holes. Splitting a
 * sentence into fragments to interpolate a `<code>` would be absurd, and dropping inline markup would
 * make the guide unreadable.
 *
 * What *is* converted is every structural block, and the reason is where the data is. A table on the
 * errors page carries three hundred codes, file paths and messages extracted from source; the API
 * page carries signatures. Those are values, they flow through holes, and the compiler escapes them.
 * Prose is authored text in this repository, interpolates nothing, and goes through `raw` — which is
 * the same bargain `markup.ts` already made, now declared in one place and visible on the block.
 *
 * The arms are a chained conditional, so each block kind is a sealed template and the byte layout of
 * a row does not depend on which one a block picks.
 */
export default fragment(({ blocks }: PageProps) => (
  <div class="page-body">
    {blocks.map((block) => (
      <div class="block" data-block={block.kind}>
        {block.isProse ? (
          <div class="prose">
            {block.paragraphs.map((paragraph) => (
              <p>{raw(paragraph.html)}</p>
            ))}
          </div>
        ) : block.isHeading ? (
          <h2 id={block.id}>
            <a class="anchor" href={`#${block.id}`}>
              {block.text}
            </a>
          </h2>
        ) : block.isNote ? (
          <Note kind={block.noteKind} title={block.title} body={block.body} />
        ) : block.isTable ? (
          <Table headers={block.headers} rows={block.rows} />
        ) : block.isOption ? (
          <Option
            name={block.name}
            id={block.id}
            type={block.optionType}
            fallback={block.fallback}
            requirement={block.requirement}
            paragraphs={block.paragraphs}
            memberHeaders={block.headers}
            memberRows={block.rows}
            hasMembers={block.hasMembers}
            example={block.example}
            hasExample={block.hasExample}
          />
        ) : block.isFigure ? (
          <figure class="code">
            <figcaption>{block.caption}</figcaption>
            <pre>
              <code data-lang={block.lang}>{raw(block.code)}</code>
            </pre>
          </figure>
        ) : (
          <div class="bespoke">{raw(block.html)}</div>
        )}
      </div>
    ))}
  </div>
))
