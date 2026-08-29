import { fragment, raw } from '@weftjs/core'
import Note from './note.tsx'
import Option from './option.tsx'
import Table from './table.tsx'
import type { Cell } from './table.tsx'

/** One block of a page body. Every field is present on every block, because a heterogeneous list needs one row template. Unused fields are empty and compress to nothing. */
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
  /** The reference entry's own fields. `id`, `paragraphs`, `headers` and `rows` are shared with the blocks above it. */
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
 * Prose stays `raw` rather than converted to holes — 179 inline tags (`<code>`, `<strong>`,
 * `<a href>`, `<em>`) live inside this site's prose, and splitting sentences to interpolate them
 * would be absurd. Structural blocks (tables, options) carry real data instead, so those go
 * through holes and the compiler escapes them.
 *
 * The arms are a chained conditional, so each block kind is a sealed template and a row's byte
 * layout does not depend on which one it picks.
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
