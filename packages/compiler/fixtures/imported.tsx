import { fragment, signal } from '@weft/core'
import { Badge } from './badge.tsx'
import { addToCart } from './intents.ts'

export default fragment(({ sku }: { sku: number }) => {
  const tone = signal('ok')
  return (
    <form data-sku={sku} onSubmit={addToCart}>
      <Badge tone={tone()} label="in stock" />
    </form>
  )
})
