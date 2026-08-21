import { fragment, raw } from 'weft'

interface RaceProps {
  title: string
  css: string
  order: string
  note: string
  fast: string
  medium: string
  slow: string
}

/**
 * The streaming race, as its own document so it can be loaded in a frame and watched.
 *
 * Three slots with three different latencies. In `out-of-order` the shell goes out with an anchor
 * at each slot and whichever region resolves first is sent first — the pipe is filled with whatever
 * is ready. In `in-order` each region streams where it sits, so the fast one waits behind the slow
 * one purely because of where it is in the document.
 *
 * Nothing here animates. Each region reports the millisecond it was rendered at, relative to the
 * start of the request, so the arrival order is still legible after the page has finished loading.
 */
export default fragment(({ title, css, order, note, fast, medium, slow }: RaceProps) => (
  <>
    {raw('<!doctype html>')}
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>{title}</title>
        <link rel="stylesheet" href={css} />
      </head>
      <body class="race" data-order={order}>
        <p class="race-order">{order}</p>
        <p class="race-note">{note}</p>
        <div class="race-lanes">
          <div class="lane" data-lane="slow">
            <span class="lane-name">slow · first in the document</span>
            <slot name="slow">{slow}</slot>
          </div>
          <div class="lane" data-lane="fast">
            <span class="lane-name">fast · second</span>
            <slot name="fast">{fast}</slot>
          </div>
          <div class="lane" data-lane="medium">
            <span class="lane-name">medium · last</span>
            <slot name="medium">{medium}</slot>
          </div>
        </div>
      </body>
    </html>
  </>
))
