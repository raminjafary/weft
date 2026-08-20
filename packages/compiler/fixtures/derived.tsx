import { fragment, signal } from 'weft'
import { addToCart, setQuantity } from './intents.ts'

export default fragment(({ sku, price }: { sku: number; price: number }) => {
  const qty = signal(1)
  return (
    <form data-sku={sku} onSubmit={addToCart}>
      <input type="number" value={qty()} onInput={setQuantity} />
      <output>{qty() * 100}</output>
      <p>{price / 100}</p>
      <button disabled={qty() > 9}>Add</button>
    </form>
  )
})
