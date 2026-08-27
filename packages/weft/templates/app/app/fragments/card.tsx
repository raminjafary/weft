import { fragment } from '@weft/core'

interface Props {
  title: string
  body: string
}

/**
 * An ordinary component: props in, markup out. Sealed once, however many times a page renders it.
 *
 * Its stylesheet is the `.css` beside it, and only the pages that render this fragment link it.
 */
export default fragment(({ title, body }: Props) => (
  <article class="card">
    <h3>{title}</h3>
    <p>{body}</p>
  </article>
))
