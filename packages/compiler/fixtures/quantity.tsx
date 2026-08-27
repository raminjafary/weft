import { fragment, signal } from '@weft/core'
import { addToCart, setQuantity } from './intents.ts'

export default fragment(({ sku }: { sku: number }) => {
  const qty = signal(1)
  return (
    <form data-sku={sku} onSubmit={addToCart}>
      <input type="number" value={qty()} onInput={setQuantity} />
      <output>{qty()}</output>
      <button disabled={qty()}>Add</button>
    </form>
  )
})
