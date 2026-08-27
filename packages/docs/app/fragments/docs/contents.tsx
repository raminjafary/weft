import { fragment } from '@weft/core'

/** One entry. `count` and `current` are strings because a hole is filled, never branched on. */
export interface ContentsItem {
  label: string
  href: string
  /** Rendered beside the label. Empty string for an entry that has no number. */
  count: string
  /** `'page'` for the entry you are on, `'false'` otherwise — the value of `aria-current`. */
  current: string
}

export interface ContentsGroup {
  label: string
  items: ContentsItem[]
}

/**
 * The sidebar nav, for every section of the site that has one.
 *
 * This replaced three near-identical string builders — `guideContents`, `glossaryContents`,
 * `galleryContents`, `errorsContents` — and it is the first piece of this site's chrome that is a
 * sealed template rather than concatenated markup. That is the whole point: the guide's contents
 * column is byte-identical on every page under `/guide`, so as a template it is one cache entry and
 * one adopt payload instead of a string rebuilt per render.
 *
 * Two shapes the compiler refuses, which is why the props look like this rather than like the
 * strings they replaced:
 *
 * `E_EXPRESSION_UNSUPPORTED` — a `ConditionalExpression` cannot appear in a template. A sealed
 * template's byte layout is fixed and only its holes vary, so `current ? <strong/> : <a/>` is not
 * expressible. The current entry is therefore still a link, carrying `aria-current="page"`, and the
 * weight comes from CSS. That is the better markup anyway: it is the attribute assistive technology
 * actually reads for "you are here", which a `<strong>` is not.
 *
 * `E_ROW_NOT_SINGLE_ROOT` — a mapped row must be one element, or the parent's children cannot be
 * divided into rows. Hence the wrapper around each group rather than a bare heading-and-list pair.
 */
export default fragment(({ groups }: { groups: ContentsGroup[] }) => (
  <nav class="contents-nav">
    {groups.map((group) => (
      <div class="contents-group">
        <h2 class="hint">{group.label}</h2>
        <ul class="contents">
          {group.items.map((item) => (
            <li>
              <a href={item.href} aria-current={item.current}>
                {item.label}
              </a>
              <span class="count">{item.count}</span>
            </li>
          ))}
        </ul>
      </div>
    ))}
  </nav>
))
