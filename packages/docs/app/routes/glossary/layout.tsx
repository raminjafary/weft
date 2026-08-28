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
 * The glossary's layout: the terms under their letters, and the terms.
 *
 * The index used to be a row of letter chips in the route's body string, recomputed and re-sent
 * with the prose on every render. It is the contents rail now — a sealed template, one cache entry,
 * and the same column the rest of the site indexes a section in — with the letters as its group
 * headings, so the index is the terms rather than a second thing pointing at them.
 */
export default fragment(
  ({ heading, lede, kickerClass, kicker, kickerNote, contents, body, outline }: Props) => (
    <div class="shell two">
      <aside class="rail" aria-label="Reference">
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
