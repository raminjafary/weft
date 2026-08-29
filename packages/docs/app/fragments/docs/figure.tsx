import { fragment, raw } from '@weftjs/core'

export interface FigureProps {
  /** Shown above the block. Empty means no caption bar at all. */
  caption: string
  /** Pre-highlighted markup: token spans the highlighter produced, so it arrives trusted. */
  html: string
  /** Names the language for `data-lang`, and `sketch` adds the not-compiled marker. */
  lang: string
  sketch: boolean
}

/**
 * A code block: the caption, and the highlighted source. `html` is what `highlight()` produced —
 * token spans over text it escaped itself, the same bargain `raw()` makes elsewhere, declared once
 * here instead of at four call sites. Caption and sketch marker are variants, so a plain block
 * carries no hidden marker element.
 */
export default fragment(({ caption, html, lang, sketch }: FigureProps) => (
  <figure class="code">
    <div class="fig-head">
      {caption ? (
        <figcaption>
          {sketch ? <span class="sketch-mark">✎ sketch — not compiled</span> : <span>{caption}</span>}
        </figcaption>
      ) : (
        <span class="none" />
      )}
    </div>
    <pre>
      <code data-lang={lang}>{raw(html)}</code>
    </pre>
  </figure>
))
