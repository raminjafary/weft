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

/** Reads nothing, so its class is `static` — a CDN could serve it without the kernel being invoked. The wrapping `div` is required: `E_LIST_NOT_SOLE_CHILD`. */
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
