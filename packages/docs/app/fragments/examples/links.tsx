import { fragment } from '@weftjs/core'

interface Link {
  href: string
  label: string
  /** Whether this is the page you are on. Per item, because a row receives only its own item. */
  here: boolean
}

/**
 * Ordinary anchors — nothing opts a link into instant navigation. See `spec/client/navigation.md`.
 * `here` is a field on the item, not a `current` prop compared inside the row: a row receives only
 * its own item, and reading an outer value is `E_OUT_OF_ROW_SCOPE`. See `spec/compiler/supported-subset.md`.
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
