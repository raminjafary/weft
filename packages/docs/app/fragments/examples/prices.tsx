import { fragment } from '@weft/core'

interface Line {
  sku: string
  name: string
  price: number
}

/**
 * The fragment the wire-form comparison on `/guide/live-regions` is computed from.
 *
 * Nothing about it is special — a heading, a total and one row template — and that is the point.
 * `html`, `patch` and `delta` are three encodings of the *same* sealed template, so the byte counts
 * beside it are three ways of saying one price changed, not three implementations.
 */
export default fragment(({ heading, total, lines }: { heading: string; total: number; lines: Line[] }) => (
  <section class="prices">
    <h3>{heading}</h3>
    <table class="rows">
      <tbody>
        {lines.map((line) => (
          <tr data-sku={line.sku}>
            <td>{line.name}</td>
            <td class="num">{line.price}</td>
          </tr>
        ))}
      </tbody>
    </table>
    <p class="total">
      Total <output>{total}</output>
    </p>
  </section>
))
