import { fragment } from 'weft'

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
 * The API reference's layout: the package list, the package, and what is in this module.
 *
 * A third file with the same holes, for the reason given in `../tutorial/layout.tsx`. What is
 * different is what fills them: this section's body is generated from the source tree rather than
 * written, so the page is a view over the packages and not a copy of them — which is what the
 * `generated` chip above the heading is there to say before anybody trusts a signature on it.
 */
export default fragment(
  ({ heading, lede, section, kickerClass, kicker, kickerNote, contents, body, outline }: Props) => (
    <div class="shell">
      <aside class="rail" aria-label="Packages">
        <slot name="contents">{contents}</slot>
      </aside>
      <article class="api">
        <div class="crumb-slot">
          {section ? (
            <nav class="crumbs" aria-label="Breadcrumb">
              <a href="/api">API</a>
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
