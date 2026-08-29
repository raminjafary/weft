import { fragment } from '@weftjs/core'

interface Row {
  label: string
  value: string
  note: string
  state: string
}

interface PanelProps {
  caption: string
  rows: Row[]
}

/** The readout every station uses. A fragment rather than a template literal, so a number arrives through the same render path as the content. */
export default fragment(({ caption, rows }: PanelProps) => (
  <div class="readout-table">
    <h3>{caption}</h3>
    <dl>
      {rows.map((row) => (
        <div class="row" data-state={row.state}>
          <dt>{row.label}</dt>
          <dd class="value">{row.value}</dd>
          <dd class="note">{row.note}</dd>
        </div>
      ))}
    </dl>
  </div>
))
