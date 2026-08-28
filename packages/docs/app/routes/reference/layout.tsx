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
  /** Where this page came from, and what argues for it. See `lib/reference-page.ts`. */
  prov: string
}

/**
 * The reference's layout: what you write on the left, this page's fields on the right.
 *
 * Three columns, which the guide and the API page also have and the error reference deliberately
 * does not. The argument is the same as the guide's: the outline column here is not a courtesy, it
 * is the section's index — a config page is twenty-nine entries and the only way to use it as a
 * reference rather than as an essay is to be able to see every option name at once and jump to one.
 */
export default fragment(
  ({ heading, lede, section, kickerClass, kicker, kickerNote, contents, body, outline, prov }: Props) => (
    <div class="shell">
      <aside class="rail" aria-label="References">
        <slot name="contents">{contents}</slot>
      </aside>
      <article class="reference">
        <div class="crumb-slot">
          {section ? (
            <nav class="crumbs" aria-label="Breadcrumb">
              <a href="/reference">Reference</a>
              <span>/</span>
              <span aria-current="page">{section}</span>
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
        <div class="rail-foot" aria-label="Where this came from">
          <slot name="prov">{prov}</slot>
        </div>
      </aside>
    </div>
  ),
)
