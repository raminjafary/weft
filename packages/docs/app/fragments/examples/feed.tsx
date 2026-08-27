import { fragment, type Ctx } from '@weft/core'

interface Item {
  id: number
  title: string
  price: number
}

/**
 * A region whose bytes cannot be part of the shell.
 *
 * Reading the clock taints `time`, and `time` forces a TTL: a policy without one would never
 * expire, so declaring `cache: { class: 'public' }` with no `ttl` on the route that places this
 * fragment is a build error rather than an entry that outlives its data.
 *
 * The list is the other half of why this is the streaming example. Rows are one sealed template
 * projected once per item, so what arrives late is values rather than markup.
 *
 * `count` is a prop rather than `items.length`, because a hole binds a value and `items.length` is an
 * expression the compiler has no lowering for: `E_EXPRESSION_UNSUPPORTED`, naming it.
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
