import { fragment } from 'weft'

interface Props {
  heading: string
  lede: string
  /** `crumbs`, or `crumbs none` on an index page that has no trail to draw. */
  crumbClass: string
  section: string
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
 * The tutorial's layout. The same holes the guide leaves, and a separate file.
 *
 * It has to be a separate file rather than a shared component, and the reason is a refusal worth
 * knowing about: a `<slot>` inside a composed instance is `E_COMPONENT_CHILDREN_UNSUPPORTED`, so a
 * template cannot delegate its own boundaries to a child. A layout's holes are the boundaries the
 * kernel fills, and a boundary has to be a cut point in *this* template's byte stream.
 *
 * The cost is this file looking like the guide's. The benefit is that each of these holes is a real
 * cut, streamed independently, with its own cache policy — which a shared component could not give.
 */
export default fragment(
  ({
    heading,
    lede,
    crumbClass,
    section,
    headClass,
    kickerClass,
    kicker,
    kickerNote,
    contents,
    body,
    outline,
  }: Props) => (
    <div class="shell">
      <aside class="rail" aria-label="Tutorial steps">
        <slot name="contents">{contents}</slot>
      </aside>
      <article>
        <nav class={crumbClass} aria-label="Breadcrumb">
          <a href="/tutorial">Tutorial</a>
          <span>/</span>
          <span>{section}</span>
          <span>/</span>
          <span aria-current="page">{heading}</span>
        </nav>
        <div class={headClass}>
          <span class={kickerClass}>{kicker}</span>
          <span class="hint">{kickerNote}</span>
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
