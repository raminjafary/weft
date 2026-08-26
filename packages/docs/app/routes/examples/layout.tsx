import { fragment } from 'weft'

interface Props {
  heading: string
  contents: string
  body: string
  outline: string
}

/**
 * The gallery's layout: which page each example came from, the examples, and what produced them.
 *
 * One route under it rather than many, which makes this the section where the layout is least
 * obviously worth a file — until you read the body, which is every example on the site in one
 * document. A page that long is the case a contents column exists for.
 */
export default fragment(({ heading, contents, body, outline }: Props) => (
  <div class="guide">
    <aside class="guide-contents" aria-label={heading}>
      <slot name="contents">{contents}</slot>
    </aside>
    <article class="guide-body">
      <slot name="body">{body}</slot>
    </article>
    <aside class="guide-outline" aria-label="What these examples are">
      <slot name="outline">{outline}</slot>
    </aside>
  </div>
))
