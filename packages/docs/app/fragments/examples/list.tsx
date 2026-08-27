import { fragment } from '@weftjs/core'

interface Row {
  sku: string
  name: string
  price: number
}

/**
 * A list is one sealed row template, projected once per item.
 *
 * This is why page weight tracks content rather than markup: a fifty-row table is fifty rows of
 * values and two templates, and a delta over it addresses the rows that changed.
 */
export default fragment(({ rows }: { rows: Row[] }) => (
  <table class="rows">
    <tbody>
      {rows.map((row) => (
        <tr>
          <td>
            <code>{row.sku}</code>
          </td>
          <td>{row.name}</td>
          <td class="num">{row.price}</td>
        </tr>
      ))}
    </tbody>
  </table>
))
