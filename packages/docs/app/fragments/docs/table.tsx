import { fragment } from '@weftjs/core'

/**
 * One cell, as data rather than as markup.
 *
 * Four shapes cover every table on this site, and they are flags rather than a kind string because a
 * template branches on a value and not on a comparison: `href` decides a link, `code` decides
 * monospace, `hint` decides the dim treatment a missing value gets. A plain cell sets none of them.
 */
export interface Cell {
  text: string
  /** Non-empty makes the cell a link. */
  href: string
  code: boolean
  hint: boolean
}

export interface TableProps {
  headers: string[]
  rows: { cells: Cell[] }[]
}

/**
 * Every table on the site, as one sealed template.
 *
 * It replaced `markup.ts`'s `table()`, which took `readonly string[][]` of pre-built HTML — so every
 * call site assembled its own `<a>` and `<code>` and hand-escaped what went inside them. A cell's
 * text goes through a hole now, which is what moves the escape decision from twenty call sites to
 * the compiler.
 *
 * The cell body is a chained conditional, which is the shape this needed and the reason the compiler
 * learned it: four arms, each sealed as its own template, and the byte layout identical whichever
 * one a value picks. Written before conditional shapes existed, this component could only have taken
 * strings — which is how `table()` came to take strings in the first place.
 *
 * The wrapper keeps `.scroll`, because a table wider than its column has to scroll inside its own
 * box rather than widen the page.
 */
export default fragment(({ headers, rows }: TableProps) => (
  <div class="scroll">
    <table>
      <thead>
        <tr>
          {headers.map((header) => (
            <th>{header}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr>
            {row.cells.map((cell) => (
              <td>
                {cell.href ? (
                  <a href={cell.href}>
                    {/* A link may also be code — an error code linking to its page is both, and
                        checking `href` first would otherwise silently drop the monospace. */}
                    {cell.code ? <code>{cell.text}</code> : <span>{cell.text}</span>}
                  </a>
                ) : cell.code ? (
                  <code>{cell.text}</code>
                ) : cell.hint ? (
                  <span class="hint">{cell.text}</span>
                ) : (
                  <span>{cell.text}</span>
                )}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
))
