import { fragment, raw } from '@weft/core'

interface NavItem {
  href: string
  label: string
  current: string
}

interface LayoutProps {
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
 * The document, when the application has not written one.
 *
 * Three `<slot>` holes, which is what lets the kernel send everything above the first one
 * before it knows anything about what fills it. `<slot>` is a real element here rather than
 * shadow DOM: outside a shadow root it renders its children, so in-order streaming needs no
 * fill mechanism at all.
 *
 * An application that wants a different document writes `app/layout.tsx` and this file stops
 * being used. Nothing else changes — the slot holes it declares are the ones the framework
 * fills, whatever they are called.
 */
export default fragment(
  ({ title, description, css, runtime, brand, nav, header, body, footer }: LayoutProps) => (
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
  ),
)
