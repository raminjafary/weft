import { fragment } from '@weftjs/core'

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
 * The sidebar nav, for every section of the site that has one — replaced three near-identical
 * string builders with a sealed template, byte-identical on every page under `/guide`.
 *
 * The current entry stays a link (`aria-current="page"`, weight from CSS) rather than a
 * `<strong>`, since `current ? <strong/> : <a/>` is `E_EXPRESSION_UNSUPPORTED` in a sealed
 * template — and it's the better markup anyway, the attribute assistive tech actually reads. The
 * wrapper around each group is `E_ROW_NOT_SINGLE_ROOT`: a mapped row must be one element. See
 * `spec/compiler/supported-subset.md`.
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
