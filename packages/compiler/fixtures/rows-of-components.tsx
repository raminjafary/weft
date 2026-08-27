import { fragment } from '@weftjs/core'
import { setQuantity } from './intents.ts'

/** One instance per row, so the row template names a child template of its own. */
const Tag = fragment(({ tone, label }: { tone: string; label: string }) => <em class={tone}>{label}</em>)

interface Row {
  sku: number
  name: string
  tone: string
  label: string
}

export default fragment(({ epoch, rows }: { epoch: string; rows: Row[] }) => (
  <ul class="tagged" data-epoch={epoch}>
    {rows.map((row) => (
      <li data-sku={row.sku} onInput={setQuantity}>
        <span class="name">{row.name}</span>
        <Tag tone={row.tone} label={row.label} />
      </li>
    ))}
  </ul>
))
