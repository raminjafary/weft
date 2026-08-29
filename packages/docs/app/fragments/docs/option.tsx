import { fragment, raw } from '@weftjs/core'
import Table from './table.tsx'
import type { Cell } from './table.tsx'

/**
 * One option, as a reference entry: the name, what it accepts, what it defaults to, and why. A
 * table row can't hold this — the `documents` option's argument alone is eleven hundred
 * characters. Every value goes through a hole and is escaped by the compiler, except the doc's
 * paragraphs, which arrive pre-escaped with backticks turned into `<code>` (in `declared.ts`).
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
  /** A line or two showing the shape, highlighted before it got here. Written by hand, checked by the same test that walks the guide's sketches. */
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
