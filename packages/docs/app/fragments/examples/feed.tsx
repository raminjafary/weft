import { fragment, type Ctx } from '@weftjs/core'

interface Item {
  id: number
  title: string
  price: number
}

/**
 * The streaming example. Reading the clock taints `time` and forces a TTL. See
 * `spec/kernel/cache.md`. `count` is a prop rather than `items.length`, since a hole binds a value
 * and `.length` is an expression the compiler has no lowering for (`E_EXPRESSION_UNSUPPORTED`).
 */
export default fragment(({ count, items }: { count: number; items: Item[] }, ctx: Ctx) => {
  const generated = ctx.now()
  return (
    <section class="feed">
      <p class="meta">
        <span class="count">{count}</span> items · generated at <span class="at">{generated}</span>
      </p>
      <ol class="items">
        {items.map((item) => (
          <li data-id={item.id}>
            <span class="title">{item.title}</span>
            <span class="price">{item.price}</span>
          </li>
        ))}
      </ol>
    </section>
  )
})
