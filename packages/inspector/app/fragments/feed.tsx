import { fragment, type Ctx } from 'weft'

interface Item {
  id: number
  title: string
  source: string
  price: number
  delta: string
  updated: string
}

interface FeedProps {
  heading: string
  count: number
  items: Item[]
}

/**
 * The content-heavy case. Hundreds of rows, one sealed row template, and nothing on it reads
 * identity — so the whole fragment is a shared cache entry and every reader on the same base
 * render gets the same delta out of the memo rather than their own diff.
 */
export default fragment(({ heading, count, items }: FeedProps, ctx: Ctx) => {
  // Reading the clock taints `time`, which forces a TTL: a cache policy without one would never
  // expire. Declaring `.cache('public')` on this fragment with no ttl is a build error, and that
  // is the compiler contradicting the plan rather than the plan being trusted.
  const generated = ctx.now()

  return (
    <section class="feed">
      <h2>{heading}</h2>
      <p class="meta">
        <span class="count">{count}</span> items · generated <span class="at">{generated}</span>
      </p>
      <ol class="items">
        {items.map((item) => (
          <li data-id={item.id} data-move={item.delta}>
            <span class="title">{item.title}</span>
            <span class="source">{item.source}</span>
            <span class="price">{item.price}</span>
            <span class="move">{item.delta}</span>
            <time>{item.updated}</time>
          </li>
        ))}
      </ol>
    </section>
  )
})
