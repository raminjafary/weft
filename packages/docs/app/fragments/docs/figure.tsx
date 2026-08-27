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
 * A code block: the caption, and the highlighted source.
 *
 * The one component here that takes markup rather than text, and the exception is narrow enough to
 * be safe: `html` is what `highlight()` produced, which is token spans over text it escaped itself.
 * That is the same bargain `markup.ts`'s `raw()` makes, declared in one place instead of at four
 * call sites.
 *
 * The caption and the sketch marker are variants, so a block without a caption emits no caption bar
 * and an ordinary block carries no marker element — rather than both always being present and hidden.
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
