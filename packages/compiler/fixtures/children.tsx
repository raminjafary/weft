import { fragment } from '@weft/core'

interface CardProps {
  title: string
  /** The markup a call site writes between the tags. Never a value: the compiler cuts it. */
  children: unknown
}

/**
 * A wrapper. It knows where the caller's markup goes and nothing about what is in it, which
 * is the whole point — one sealed template serves every call site.
 */
const Card = fragment(({ title, children }: CardProps) => (
  <section class="card">
    <h2>{title}</h2>
    <div class="body">{children}</div>
  </section>
))

interface ChildrenProps {
  heading: string
  /** Read only inside the children markup, so it proves the caller still owns the binding. */
  note: string
  total: number
}

export default fragment(({ heading, note, total }: ChildrenProps) => (
  <main class="page">
    <Card title={heading}>
      <p class="note">{note}</p>
      <p class="total">Total: {total} IQD</p>
    </Card>
  </main>
))
