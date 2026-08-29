import { fragment } from '@weftjs/core'

interface DocsProps {
  heading: string
  toc: string
  body: string
}

/** A layout for a subtree, nested inside the application's own document: shell, then this, then the page. See `spec/kernel/routing.md`. */
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
