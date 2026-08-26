import { fragment } from 'weft'

interface Props {
  heading: string
  contents: string
  body: string
  outline: string
}

/**
 * The tutorial's layout. The same three holes the guide leaves, and a separate file.
 *
 * It has to be a separate file rather than a shared component, and the reason is a refusal worth
 * knowing about: a `<slot>` inside a composed instance is `E_COMPONENT_CHILDREN_UNSUPPORTED`, so a
 * template cannot delegate its own boundaries to a child. A layout's holes are the boundaries the
 * kernel fills, and a boundary has to be a cut point in *this* template's byte stream.
 *
 * The cost is this file looking like the guide's. The benefit is that each of these holes is a real
 * cut, streamed independently, with its own cache policy — which a shared component could not give.
 */
export default fragment(({ heading, contents, body, outline }: Props) => (
  <div class="guide">
    <aside class="guide-contents" aria-label={heading}>
      <slot name="contents">{contents}</slot>
    </aside>
    <article class="guide-body">
      <slot name="body">{body}</slot>
    </article>
    <aside class="guide-outline" aria-label="Where this is specified">
      <slot name="outline">{outline}</slot>
    </aside>
  </div>
))
