import { fragment } from '@weft/core'

interface Props {
  heading: string
  lede: string
  kickerClass: string
  kicker: string
  kickerNote: string
  contents: string
  body: string
  outline: string
}

/**
 * Quick Start's own layout, and the reason it has one.
 *
 * The page was at the top level and had no rail, which made it the one page where a reader who
 * finished it had nowhere to go. It is a section of one now: the same three columns as the guide,
 * with a rail that names the other two ways in and the first four pages of the guide.
 *
 * There is no breadcrumb here, because a section of one has nothing to be a trail through.
 */
export default fragment(
  ({ heading, lede, kickerClass, kicker, kickerNote, contents, body, outline }: Props) => (
    <div class="shell start">
      <aside class="rail" aria-label="Getting started">
        <slot name="contents">{contents}</slot>
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
      <aside class="outline-rail" aria-label="On this page">
        <slot name="outline">{outline}</slot>
      </aside>
    </div>
  ),
)
