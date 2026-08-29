import { fragment, raw } from '@weftjs/core'

interface NavItem {
  href: string
  label: string
  current: string
}

interface Mode {
  href: string
  label: string
  current: string
}

interface RaceProps {
  title: string
  css: string
  nav: NavItem[]
  order: string
  note: string
  modes: Mode[]
  fast: string
  medium: string
  slow: string
}

/**
 * The streaming race, as its own document so it can be loaded in a frame and watched. Three slots,
 * three latencies, `out-of-order` vs `in-order`. See `spec/kernel/streaming.md`. Nothing animates:
 * each region reports the millisecond it rendered at, so arrival order stays legible after load.
 */
export default fragment(({ title, css, nav, order, note, modes, fast, medium, slow }: RaceProps) => (
  <>
    {raw('<!doctype html>')}
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>{title}</title>
        <link rel="stylesheet" href={css} />
      </head>
      <body class="race" data-order={order}>
        <header class="top">
          <a class="brand" href="/">
            weft
          </a>
          <nav>
            {nav.map((item) => (
              <a href={item.href} data-current={item.current}>
                {item.label}
              </a>
            ))}
          </nav>
        </header>
        <nav class="race-top">
          {/* Its own element: a list must be the only child of one. See `spec/compiler/supported-subset.md`. */}
          <span class="race-modes">
            {modes.map((mode) => (
              <a href={mode.href} data-current={mode.current}>
                {mode.label}
              </a>
            ))}
          </span>
        </nav>
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
