import { fragment } from 'weft'
import Badge from './badge.tsx'

/**
 * A fragment rendering another fragment.
 *
 * `<Badge/>` is not mounted and it is not a function call at runtime: the compiler resolves the tag
 * to a sealed template and leaves a component hole that projects this fragment's values into it. So
 * one `Badge` used a hundred times is one sealed template and a hundred projections.
 */
export default fragment(({ title, label }: { title: string; label: string }) => (
  <article class="card">
    <h3>{title}</h3>
    <Badge label={label} />
  </article>
))
