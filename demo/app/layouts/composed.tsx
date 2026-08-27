import { fragment, raw } from '@weft/core'

interface NavItem {
  href: string
  label: string
  current: string
}

interface ComposedProps {
  title: string
  description: string
  css: string
  runtime: string
  heading: string
  shows: string
  nav: NavItem[]
  panel: string
  search: string
  body: string
}

/**
 * A document with a hole that another deployment fills.
 *
 * Nothing here says so, and that is the claim. `<slot name="search">` is the same element as the
 * three holes in `layout.tsx` — the compiler cuts the document at the same kind of point, the kernel
 * streams everything before the cut without knowing what fills it, and the client finds the region
 * by the same `data-weft-slot` wrapper. Which deployment renders it is a line in `weft.config.ts`.
 *
 * So this file is evidence rather than decoration: if composing a region needed anything of a
 * layout, it would be visible here.
 */
export default fragment(
  ({ title, description, css, runtime, heading, shows, nav, panel, search, body }: ComposedProps) => (
    <>
      {raw('<!doctype html>')}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width,initial-scale=1" />
          <title>{title}</title>
          <meta name="description" content={description} />
          <link rel="stylesheet" href={css} />
          <script type="module" src={runtime} />
        </head>
        <body>
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
          <main>
            <h1>{heading}</h1>
            <p class="shows">{shows}</p>
            <section class="panel">
              <slot name="panel">{panel}</slot>
            </section>
            <section class="search">
              <slot name="search">{search}</slot>
            </section>
            <section class="body">
              <slot name="body">{body}</slot>
            </section>
          </main>
        </body>
      </html>
    </>
  ),
)
