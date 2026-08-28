import { fragment, raw } from '@weftjs/core'
import Table from './table.tsx'
import type { Cell } from './table.tsx'

/**
 * One option, as a reference entry: the name, what it accepts, what it defaults to, and why.
 *
 * The shape is the one every API reference converged on — Nuxt's config page, MDN, the Rust book —
 * and it converged there because it answers the three questions somebody with a config file open
 * actually has, in the order they have them. A table row cannot: the `documents` option's argument
 * is eleven hundred characters, and a cell that wide is a cell nobody reads.
 *
 * Every value here goes through a hole and is escaped by the compiler. The one exception is the
 * doc's paragraphs, which arrive already escaped with backticks turned into `<code>` — the same
 * bargain the guide's prose makes, made in `declared.ts` rather than at a call site.
 */
export interface OptionProps {
  name: string
  /** The anchor, which is the name prefixed where two interfaces share a field name. */
  id: string
  /** The type as written in the source. */
  type: string
  /** What it is without you: a literal, `derived`, or empty for a port that is simply unbound. */
  fallback: string
  /** `required` or `optional`, as the chip beside the name. */
  requirement: string
  paragraphs: { html: string }[]
  /** Members of an inline object type, when the option takes one. */
  memberHeaders: string[]
  memberRows: { cells: Cell[] }[]
  /** Non-empty draws the nested table. */
  hasMembers: string
  /**
   * A line or two showing the shape, highlighted before it got here.
   *
   * Written by hand, and the only thing on these pages that is — a type says what a field accepts
   * and a doc comment says why, and neither of them shows you what to type. Every one of them is
   * checked: the test that walks the guide's sketches for imports that do not exist walks these too.
   */
  example: string
  /** Non-empty draws the example. */
  hasExample: string
}

export default fragment(
  ({
    name,
    id,
    type,
    fallback,
    requirement,
    paragraphs,
    memberHeaders,
    memberRows,
    hasMembers,
    example,
    hasExample,
  }: OptionProps) => (
    <section class="option" id={id}>
      <h3 class="option-head">
        <a class="anchor" href={`#${id}`}>
          <code>{name}</code>
        </a>
        <span class={`option-req is-${requirement}`}>{requirement}</span>
      </h3>
      <dl class="option-meta">
        <div class="option-row">
          <dt>Type</dt>
          <dd>
            <code>{type}</code>
          </dd>
        </div>
        <div class="option-row">
          <dt>Default</dt>
          <dd>
            <code>{fallback}</code>
          </dd>
        </div>
      </dl>
      <div class="option-doc">
        {paragraphs.map((paragraph) => (
          <p>{raw(paragraph.html)}</p>
        ))}
      </div>
      <div class="option-example">
        {hasExample ? (
          <figure class="code">
            <pre>
              <code data-lang="ts">{raw(example)}</code>
            </pre>
          </figure>
        ) : (
          <span class="none" />
        )}
      </div>
      <div class="option-members">
        {hasMembers ? <Table headers={memberHeaders} rows={memberRows} /> : <span class="none" />}
      </div>
    </section>
  ),
)
