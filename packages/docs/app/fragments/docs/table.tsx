import { fragment } from '@weftjs/core'

/** One cell, as data rather than markup. Flags rather than a kind string, since a template branches on a value, not a comparison. */
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
 * Every table on the site, as one sealed template. Replaced `markup.ts`'s `table()`, which took
 * pre-built HTML and hand-escaped it at twenty call sites — a cell's text now goes through a hole,
 * moving the escape decision to the compiler. `.scroll` keeps a wide table inside its own box.
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
