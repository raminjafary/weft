import { fragment } from '@weftjs/core'

interface Crumb {
  href: string
  label: string
}

/**
 * What a wildcard route renders: the segments it matched, as one row template.
 *
 * The route file is `app/routes/docs/[...].tsx` and the path it matched is data, so a breadcrumb is
 * a list hole rather than a component that walks something at runtime. Nothing here knows how deep
 * the URL was.
 *
 * The `<ol>` is not decoration. A list has to be the only child of its element — otherwise a
 * sibling's position would move with the row count — so the trail gets its own element and the
 * current page sits outside it. Written the other way round, this file is
 * `E_LIST_NOT_SOLE_CHILD` at build time.
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
