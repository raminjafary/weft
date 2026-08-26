import { fragment } from 'weft'

interface Props {
  heading: string
  contents: string
  body: string
  outline: string
}

/**
 * The error reference's layout: every code, the one you are reading, and where it comes from.
 *
 * A fourth file with the same three holes, for the reason `../tutorial/layout.tsx` gives — a
 * `<slot>` cannot be delegated to a child component, so a layout's boundaries have to be cuts in
 * this template's own byte stream. The duplication is the price of each column being a real cut with
 * its own cache policy.
 *
 * The contents column is worth more here than anywhere else on the site: this subtree is a page per
 * refusal, several hundred of them, and until it existed the only way from one code to another was
 * the index.
 */
export default fragment(({ heading, contents, body, outline }: Props) => (
  <div class="guide">
    <aside class="guide-contents" aria-label={heading}>
      <slot name="contents">{contents}</slot>
    </aside>
    <article class="guide-body">
      <slot name="body">{body}</slot>
    </article>
    <aside class="guide-outline" aria-label="Where this code comes from">
      <slot name="outline">{outline}</slot>
    </aside>
  </div>
))
