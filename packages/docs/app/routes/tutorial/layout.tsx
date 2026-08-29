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
  /** `shell` for a step, `shell one` for the index — which has no rail. See `lib/shell.ts`. */
  shellClass: string
  contents: string
  body: string
  outline: string
}

/**
 * The tutorial's layout — the same holes the guide leaves, in a separate file rather than a shared
 * component: a `<slot>` inside a composed instance is `E_COMPONENT_CHILDREN_UNSUPPORTED`, since a
 * layout's holes must be cut points in *this* template's byte stream, not delegated to a child.
 */
export default fragment(
  ({
    heading,
    lede,
    section,
    kickerClass,
    kicker,
    kickerNote,
    shellClass,
    contents,
    body,
    outline,
  }: Props) => (
    <div class={shellClass}>
      <aside class="rail steps" aria-label="Tutorial steps">
        <slot name="contents">{contents}</slot>
      </aside>
      <article>
        <div class="crumb-slot">
          {section ? (
            <nav class="crumbs" aria-label="Breadcrumb">
              <a href="/tutorial">Tutorial</a>
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
