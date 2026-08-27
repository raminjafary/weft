import { fragment, raw } from 'weft'

interface NavItem {
  href: string
  label: string
  current: string
  /** The framework's scroll restore, inlined so it runs before paint. See `SCROLL_PRELUDE`. */
  prelude: string
}

interface ShellProps {
  title: string
  description: string
  css: string
  runtime: string
  heading: string
  shows: string
  control: string
  status: string
  nav: NavItem[]
  panel: string
  body: string
  readout: string
  /** The framework's scroll restore, inlined so it runs before paint. See `SCROLL_PRELUDE`. */
  prelude: string
}

/**
 * One shell for every station and every showcase.
 *
 * Three `<slot>` holes, which means the compiler cuts the document at three points and the
 * kernel can send everything before the first cut without knowing anything about what fills it.
 * The nav is a list hole over one sealed row template rather than a loop in a component, so the
 * page weight of thirty stations is thirty rows of content and one template.
 *
 * `<slot>` here is a real element, not shadow DOM. Outside a shadow root it renders its children,
 * so in-order streaming needs no fill mechanism at all and out-of-order needs only the filler
 * that moves a node into it.
 *
 * `heading`, `shows`, `control` and `status` are not values the framework supplies. Each route
 * declares them through `defineRoute({ layoutValues })`, and a hole here that no route supplies
 * fails the build with its own name — which is how this file can grow a hole safely.
 */
export default fragment(
  ({
    title,
    description,
    css,
    runtime,
    heading,
    shows,
    control,
    status,
    nav,
    panel,
    body,
    readout,
    prelude,
  }: ShellProps) => (
    <>
      {raw('<!doctype html>')}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width,initial-scale=1" />
          {/*
            This application is dark by default, with a light override below it. A browser that has
            not been told so paints its white canvas first, so every refresh began with a white frame.
            Read before the stylesheet is fetched, which is the only point early enough to stop it.
          */}
          <meta name="color-scheme" content="dark light" />
          <title>{title}</title>
          <meta name="description" content={description} />
          <link rel="stylesheet" href={css} />
          <script type="module" src={runtime} />
        </head>
        <body data-station={heading}>
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
            <h1>
              {heading}{' '}
              <span class="status" data-status={status}>
                {status}
              </span>
            </h1>
            <p class="shows">{shows}</p>
            <p class="control-note">{control}</p>
            <section class="panel">
              <slot name="panel">{panel}</slot>
            </section>
            <section class="body">
              <slot name="body">{body}</slot>
            </section>
            <section class="readout">
              <slot name="readout">{readout}</slot>
            </section>
          </main>
          {raw(prelude)}
        </body>
      </html>
    </>
  ),
)
