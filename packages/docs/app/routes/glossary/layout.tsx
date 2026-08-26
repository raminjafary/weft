import { fragment } from 'weft'

interface Props {
  heading: string
  contents: string
  body: string
  outline: string
}

/**
 * The glossary's layout: the terms, the entries, and how far the list reaches.
 *
 * The jump list this fills used to be built into the route's body string, which meant it was
 * recomputed and re-sent with the prose on every render. As a hole it is one cache entry, and the
 * column it sits in is the one the rest of the site already uses for the same job.
 */
export default fragment(({ heading, contents, body, outline }: Props) => (
  <div class="guide">
    <aside class="guide-contents" aria-label={heading}>
      <slot name="contents">{contents}</slot>
    </aside>
    <article class="guide-body">
      <slot name="body">{body}</slot>
    </article>
    <aside class="guide-outline" aria-label="What this glossary covers">
      <slot name="outline">{outline}</slot>
    </aside>
  </div>
))
