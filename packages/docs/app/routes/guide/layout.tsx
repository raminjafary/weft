import { fragment } from '@weftjs/core'

interface Props {
  heading: string
  lede: string
  /** The middle crumb. Empty draws no trail — a conditional, which a layout may carry. */
  section: string
  /** `kicker` for the accent line, `badge` for the chip a generated section wears. */
  kickerClass: string
  kicker: string
  kickerNote: string
  contents: string
  body: string
  outline: string
}

/**
 * The guide subtree's layout, nested inside the application's document. Wraps every route at or
 * under `/guide` with a contents column and an outline, both regions of their own so they are one
 * cache entry across the guide rather than a copy per page.
 *
 * The breadcrumb and kicker are always in the markup, hidden by a class when the page has none —
 * a layout's holes come from `layoutValues`, with no render to evaluate `{section ? … : …}` in, so
 * a whole class name as a plain hole is the only way to make this conditional.
 */
export default fragment(
  ({ heading, lede, section, kickerClass, kicker, kickerNote, contents, body, outline }: Props) => (
    <div class="shell">
      <aside class="rail" aria-label="Guide contents">
        <slot name="contents">{contents}</slot>
      </aside>
      <article>
        <div class="crumb-slot">
          {section ? (
            <nav class="crumbs" aria-label="Breadcrumb">
              <a href="/guide">Guide</a>
              <span>/</span>
              <span>{section}</span>
              <span>/</span>
              <span aria-current="page">{heading}</span>
            </nav>
          ) : (
            <span class="none" />
          )}
        </div>
        <div class="head-slot">
          {kicker ? (
            <div class="head-line">
              <span class={kickerClass}>{kicker}</span>
              <span class="hint">{kickerNote}</span>
            </div>
          ) : (
            <span class="none" />
          )}
        </div>
        <h1>{heading}</h1>
        <p class="lede">{lede}</p>
        <slot name="body">{body}</slot>
      </article>
      <aside class="outline-rail" aria-label="On this page">
        <slot name="outline">{outline}</slot>
      </aside>
    </div>
  ),
)
