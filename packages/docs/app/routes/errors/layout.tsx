import { fragment } from 'weft'

interface Props {
  heading: string
  lede: string
  /** `head-line`, or `head-line none` when the page has no kicker. */
  headClass: string
  /** `kicker` for the accent line, `badge` for the chip a generated section wears. */
  kickerClass: string
  kicker: string
  kickerNote: string
  contents: string
  body: string
  outline: string
}

/**
 * The error reference's layout: every code, and the one you are reading.
 *
 * Two columns rather than three, which is the design's decision and the right one: a refusal page's
 * provenance — the package, where it is raised, which spec names it — belongs beside the list of
 * codes rather than in a column of its own, because it is about *this* code and the reader is
 * already looking at the code.
 *
 * The contents column is worth more here than anywhere else on the site: this subtree is a page per
 * refusal, several hundred of them, and until it existed the only way from one code to another was
 * the index. It is also why only the package holding the current code is opened — all 326 in every
 * column made the nav 87% of each of 327 files.
 */
export default fragment(
  ({ heading, lede, headClass, kickerClass, kicker, kickerNote, contents, body, outline }: Props) => (
    <div class="shell two">
      <aside class="rail" aria-label="Where it is raised">
        <slot name="contents">{contents}</slot>
        <div class="rail-foot" aria-label="About this code">
          <slot name="outline">{outline}</slot>
        </div>
      </aside>
      <article>
        <div class={headClass}>
          <span class={kickerClass}>{kicker}</span>
          <span class="hint">{kickerNote}</span>
        </div>
        <h1>{heading}</h1>
        <p class="lede">{lede}</p>
        <slot name="body">{body}</slot>
      </article>
    </div>
  ),
)
