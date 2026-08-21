import { fragment } from 'weft'

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

/**
 * The readout every station uses: a caption and a list of measured rows. It exists as a fragment
 * rather than as a template literal in the server so that the numbers on a station page arrive
 * through the same render path as the content, and so a station's readout is a slot the shell can
 * send bytes before.
 */
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
