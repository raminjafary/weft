import { fragment, signal } from 'weft'
import { addToCart, setQuantity } from './intents.ts'

const Price = fragment(({ amount }: { amount: number }) => <span class="price">{amount / 100}</span>)

const Stepper = fragment(({ value }: { value: number }) => (
  <span class="stepper">
    <input type="number" value={value} onInput={setQuantity} />
    <output>{value * 100}</output>
  </span>
))

export default fragment(({ sku, price }: { sku: number; price: number }) => {
  const qty = signal(1)
  return (
    <form data-sku={sku} onSubmit={addToCart}>
      <Price amount={price} />
      <Stepper value={qty()} />
    </form>
  )
})
