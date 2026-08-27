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
 * The guide subtree's layout, nested inside the application's document.
 *
 * It wraps every route at or under `/guide`, and it exists because those pages share a shape the
 * landing page and the playground do not: a contents column, the page, and an outline of what the
 * page covers in the specs. Three holes reach the plan from here and one from `app/layout.tsx`, and
 * nothing in a guide page's declaration says which came from where.
 *
 * The heading and the lede moved here from the document. They belong to the article rather than to
 * the page: the design puts them in the middle column beside the rails, and a heading rendered
 * above the grid cannot be inside it.
 *
 * `contents` is a region of its own rather than markup inside the body, which is the whole reason
 * to make it a hole: it is identical on every page under this layout, so it is one cache entry
 * across the guide instead of a copy per page.
 *
 * The breadcrumb and the kicker are always in the markup and hidden by a class when the page has
 * none. That is not a shortcut: a layout may not carry a derived expression — its holes are filled
 * from the route's `layoutValues`, and there is no render in which to evaluate one — so
 * `E_LAYOUT_HOLE_UNFILLED` is the right refusal for `{section ? … : …}` here. A whole class name as
 * a plain hole says the same thing for one hole instead of two sealed templates.
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
