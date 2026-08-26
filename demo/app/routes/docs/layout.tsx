import { fragment } from 'weft'

interface DocsProps {
  heading: string
  toc: string
  body: string
}

/**
 * A layout for a subtree, nested inside the application's own document.
 *
 * `app/routes/docs/layout.tsx` wraps every route at or under `/docs`. It is not an alternate
 * document — it does not emit `<html>` and it knows nothing about the head — it is the thing that
 * goes in `app/layout.tsx`'s `body` hole, and the two holes it leaves are the boundaries the routes
 * under it fill. So a document is a chain: shell, then this, then the page.
 *
 * The interesting part is what does *not* change. `toc` and `body` are cut points in exactly the
 * sense the outer document's are: the kernel streams everything before `toc` without knowing what
 * fills it, each has its own cache policy and budget, and the plan a route generates has four slots
 * — `panel` and `readout` from the outer layout, `toc` and `body` from this one — with no way to
 * tell from the plan which layer any of them came from.
 *
 * `heading` is the other half of that: it is one of the values the route declared through
 * `layoutValues`, and the outer document prints it too. A chain is one document with one value set,
 * so a hole here that nothing supplies fails the build with this file's name on it.
 */
export default fragment(({ heading, toc, body }: DocsProps) => (
  <div class="docs">
    <aside class="docs-toc" aria-label={heading}>
      <slot name="toc">{toc}</slot>
    </aside>
    <article class="docs-body">
      <slot name="body">{body}</slot>
    </article>
  </div>
))
