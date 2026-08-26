import { fragment } from 'weft'

interface GuideProps {
  heading: string
  contents: string
  body: string
  outline: string
}

/**
 * The guide subtree's layout, nested inside the application's document.
 *
 * It wraps every route at or under `/guide`, and it exists because those pages share a shape the
 * landing page and the playground do not: a contents column, the page, and an outline of what the
 * page covers in the specs. Two holes reach the plan from here and two from `app/layout.tsx`, and
 * nothing in a guide page's declaration says which came from where.
 *
 * `contents` is a region of its own rather than markup inside the body, which is the whole reason
 * to make it a hole: it is identical on every page under this layout, so it is one cache entry
 * across the guide instead of a copy per page.
 */
export default fragment(({ heading, contents, body, outline }: GuideProps) => (
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
