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
 * The error reference's layout: every code, and the one you are reading. Two columns, not three —
 * a code's provenance belongs beside the list of codes, not in a column of its own. Only the
 * package holding the current code is opened in the nav: all 326 in every column made the nav 87%
 * of each of 327 files.
 */
export default fragment(
  ({ heading, lede, kickerClass, kicker, kickerNote, contents, body, outline }: Props) => (
    <div class="shell two">
      <aside class="rail" aria-label="Where it is raised">
        <slot name="contents">{contents}</slot>
        <div class="rail-foot" aria-label="About this code">
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
