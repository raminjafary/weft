import { fragment } from '@weft/core'

interface Link {
  href: string
  label: string
  /** Whether this is the page you are on. Per item, because a row receives only its own item. */
  here: boolean
}

/**
 * Ordinary anchors, which is the whole demonstration.
 *
 * Nothing here opts a link into instant navigation: a link is a link, and the client stages the
 * route behind it when the deployment said staging is on. A staged route has arrived, parsed and
 * resolved and painted nothing — so the click is a commit rather than a fetch, and a page that
 * never links anywhere never carries the staging model at all.
 *
 * `here` is a field on the item rather than a `current` prop compared inside the row, because a row
 * is its own sealed template and receives only its item: reading the outer value from in here is
 * `E_OUT_OF_ROW_SCOPE`. Which is also what makes a row addressable by a delta.
 */
export default fragment(({ links }: { links: Link[] }) => (
  <nav class="links">
    {links.map((link) => (
      <a href={link.href} data-current={link.here}>
        {link.label}
      </a>
    ))}
  </nav>
))
