import { fragment } from '@weftjs/core'

interface Crumb {
  href: string
  label: string
}

/**
 * What a wildcard route renders: the segments it matched, as one row template. The `<ol>` is not
 * decoration — a list must be the only child of its element, so the trail gets its own element and
 * the current page sits outside it (`E_LIST_NOT_SOLE_CHILD`). See `spec/compiler/supported-subset.md`.
 */
export default fragment(({ trail, here }: { trail: Crumb[]; here: string }) => (
  <nav class="crumbs" aria-label="Breadcrumb">
    <ol>
      {trail.map((crumb) => (
        <li>
          <a href={crumb.href}>{crumb.label}</a>
        </li>
      ))}
    </ol>
    <span aria-current="page">{here}</span>
  </nav>
))
