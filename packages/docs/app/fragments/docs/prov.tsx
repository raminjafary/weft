import { fragment } from '@weftjs/core'

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
 * The provenance list the outline columns use: a label, a value, and where it came from. Replaced
 * three hand-built copies across `errors-page.ts`, `gallery.ts` and `glossary.ts`.
 *
 * The closing link is a `variant`, wrapped since a falsy branch can't sit beside the `h2` and `dl`
 * (`E_BRANCH_NOT_SOLE_CHILD`). `.prov-row` is `display: contents` so `dt`/`dd` stay direct grid
 * children and labels keep aligning. See `spec/compiler/supported-subset.md`.
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
