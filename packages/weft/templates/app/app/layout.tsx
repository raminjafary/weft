import { fragment, raw } from 'weft'

interface NavItem {
  href: string
  label: string
  current: string
}

interface Props {
  title: string
  description: string
  css: string
  runtime: string
  brand: string
  nav: NavItem[]
  header: string
  body: string
  footer: string
}

/**
 * The document. Yours to change — this is the only file that decides what a page looks like
 * around the edges.
 *
 * The three `<slot>` holes are what let the kernel send everything above the first one before it
 * knows anything about what fills them. `<slot>` here is a real element rather than shadow DOM:
 * outside a shadow root it renders its children, so in-order streaming needs no fill mechanism at
 * all. Add a hole and the framework fills it — from the route's own `slots`, or from
 * `app/slots/<name>.tsx`, or with nothing.
 *
 * The values it may read are title, description, css, runtime, brand and nav. Reading anything
 * else fails the build with the name of the hole, rather than rendering an empty box.
 */
export default fragment(({ title, description, css, runtime, brand, nav, header, body, footer }: Props) => (
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
        <header class="weft-top">
          <a class="weft-brand" href="/">
            {brand}
          </a>
          <nav class="weft-nav">
            {nav.map((item) => (
              <a href={item.href} data-current={item.current}>
                {item.label}
              </a>
            ))}
          </nav>
        </header>
        <slot name="header">{header}</slot>
        <main class="weft-main">
          <slot name="body">{body}</slot>
        </main>
        <slot name="footer">{footer}</slot>
      </body>
    </html>
  </>
))
