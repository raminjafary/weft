import { fragment } from 'weft'

interface Props {
  heading: string
  contents: string
  body: string
  outline: string
}

/**
 * The API reference's layout: a module list, the module, and what it covers.
 *
 * A third file with the same three holes, for the reason given in `../tutorial/layout.tsx`. What is
 * different is what fills them: this section's body is generated from the source tree rather than
 * written, so the page is a view over the packages and not a copy of them.
 */
export default fragment(({ heading, contents, body, outline }: Props) => (
  <div class="guide">
    <aside class="guide-contents" aria-label={heading}>
      <slot name="contents">{contents}</slot>
    </aside>
    <article class="guide-body api">
      <slot name="body">{body}</slot>
    </article>
    <aside class="guide-outline" aria-label="What this module is">
      <slot name="outline">{outline}</slot>
    </aside>
  </div>
))
