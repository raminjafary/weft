import { fragment } from '@weft/core'

interface Block {
  kind: string
  text: string
}

interface ArticleProps {
  title: string
  standfirst: string
  byline: string
  blocks: Block[]
}

/**
 * The case where almost nothing should ship. This fragment reads nothing at all, so its class is
 * `static`: its key is its content and a CDN could serve it without the kernel being invoked.
 * There is no update path on this page and no persistence — a page that reads does not need to
 * patch itself.
 *
 * The `div` around the blocks is not decoration: a list must be the only child of its element, so
 * that sibling positions cannot shift with the row count. Writing it without one is
 * `E_LIST_NOT_SOLE_CHILD`, which is the compiler refusing to build addressing that would silently
 * drift the first time the list grew.
 */
export default fragment(({ title, standfirst, byline, blocks }: ArticleProps) => (
  <article>
    <h2>{title}</h2>
    <p class="standfirst">{standfirst}</p>
    <p class="byline">{byline}</p>
    <div class="body-copy">
      {blocks.map((block) => (
        <p data-kind={block.kind}>{block.text}</p>
      ))}
    </div>
  </article>
))
