import { fragment } from '@weftjs/core'

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
 * The case where almost nothing should ship: reads nothing, so its class is `static`. See
 * `spec/kernel/cache.md`. The `div` around the blocks is not decoration — a list must be the only
 * child of its element, or `E_LIST_NOT_SOLE_CHILD`. See `spec/compiler/supported-subset.md`.
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
