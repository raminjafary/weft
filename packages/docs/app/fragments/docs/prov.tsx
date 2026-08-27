import { fragment } from 'weft'

export interface Fact {
  label: string
  value: string
  /** Non-empty renders the value as a link. */
  href: string
  code: boolean
}

export interface ProvProps {
  heading: string
  facts: Fact[]
  /** Non-empty adds a closing link under the list. */
  moreHref: string
  moreLabel: string
}

/**
 * The provenance list the outline columns use: a label, a value, and where it came from.
 *
 * Replaced the hand-built `<dl class="prov">` in `errors-page.ts`, `gallery.ts` and `glossary.ts` —
 * three copies of the same markup, each escaping its own values or forgetting to.
 *
 * The closing link is a `variant` rather than always-present-and-empty, so an outline without one
 * emits no `<p>` at all instead of an empty paragraph the CSS then has to hide. It sits in a wrapper
 * because `E_BRANCH_NOT_SOLE_CHILD` is right to refuse it beside the `h2` and the `dl`: a falsy
 * branch writes nothing, and a sibling after it would move.
 *
 * `.prov-row` exists because a mapped row must be a single element, and it is `display: contents` in
 * the stylesheet so the `dt` and `dd` stay direct children of the grid and the labels keep aligning
 * across rows.
 */
export default fragment(({ heading, facts, moreHref, moreLabel }: ProvProps) => (
  <div class="prov-block">
    <h2 class="hint">{heading}</h2>
    <dl class="prov">
      {facts.map((fact) => (
        <div class="prov-row">
          <dt>{fact.label}</dt>
          <dd>
            {fact.href ? (
              <a href={fact.href}>{fact.value}</a>
            ) : fact.code ? (
              <code>{fact.value}</code>
            ) : (
              <span>{fact.value}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
    <div class="prov-more">
      {moreHref ? (
        <p class="hint">
          <a href={moreHref}>{moreLabel}</a>
        </p>
      ) : (
        <span class="none" />
      )}
    </div>
  </div>
))
