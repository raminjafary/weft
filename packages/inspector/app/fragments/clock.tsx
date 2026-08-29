import { fragment, type Ctx } from '@weftjs/core'

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

/** The content-heavy case: hundreds of rows, one sealed row template, nothing reads identity, so it's a shared cache entry. */
export default fragment(({ heading, count, items }: FeedProps, ctx: Ctx) => {
  // Reading the clock taints `time`, forcing a TTL. See `spec/kernel/cache.md`.
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
