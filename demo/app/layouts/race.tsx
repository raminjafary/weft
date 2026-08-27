import { fragment, raw } from '@weft/core'

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
 * The streaming race, as its own document so it can be loaded in a frame and watched.
 *
 * Three slots with three different latencies. In `out-of-order` the shell goes out with an anchor
 * at each slot and whichever region resolves first is sent first — the pipe is filled with whatever
 * is ready. In `in-order` each region streams where it sits, so the fast one waits behind the slow
 * one purely because of where it is in the document.
 *
 * Nothing here animates. Each region reports the millisecond it was rendered at, relative to the
 * start of the request, so the arrival order is still legible after the page has finished loading.
 *
 * It carries the same chrome as every other page, from the same `nav` the framework supplies to
 * any layout that asks for it. A document with its own layout is a document with no navigation
 * unless it grows some, and a page you can arrive at and not leave is worse than a page nothing
 * links to.
 *
 * Below it, both orders, with the one you are looking at marked: this page is a comparison, and a
 * comparison whose other half is invisible is half a page.
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
          {/* Its own element, because a list has to be the only child of one: a sibling beside it
              would shift position with the row count, and adoption addresses nodes by index. */}
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
