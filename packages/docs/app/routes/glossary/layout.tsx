import { fragment } from 'weft'

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
 * The glossary's layout: the reference sections, the jump list, and the terms.
 *
 * The jump list used to be built into the route's body string, which meant it was recomputed and
 * re-sent with the prose on every render. As a hole it is one cache entry, and it sits in the rail
 * the rest of the site already uses for the same job.
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
