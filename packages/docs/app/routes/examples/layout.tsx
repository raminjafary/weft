import { fragment } from '@weftjs/core'

interface Props {
  heading: string
  lede: string
  /** `kicker` for the accent line, `badge` for the chip a generated section wears. */
  kickerClass: string
  kicker: string
  kickerNote: string
  contents: string
  body: string
  outline: string
}

/**
 * The gallery's layout: which page each example is from, and the examples.
 *
 * Two columns, because an example carries its own provenance in the facts panel underneath it —
 * a third column repeating the same numbers would be a summary of what is already on the page.
 */
export default fragment(
  ({ heading, lede, kickerClass, kicker, kickerNote, contents, body, outline }: Props) => (
    <div class="shell two">
      <aside class="rail" aria-label="Examples">
        <slot name="contents">{contents}</slot>
        <div class="rail-foot" aria-label="This page">
          <slot name="outline">{outline}</slot>
        </div>
      </aside>
      <article>
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
    </div>
  ),
)
