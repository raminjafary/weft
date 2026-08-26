import { fragment, raw } from 'weft'

interface NavItem {
  href: string
  label: string
  current: string
}

interface ShellProps {
  title: string
  description: string
  css: string
  runtime: string
  heading: string
  lede: string
  nav: NavItem[]
  body: string
}

/**
 * The document, and one slot.
 *
 * A documentation site is the case where a nested layout earns its keep, so this file deliberately
 * stops at the chrome every page shares: the head, the header, the search form, the heading and one
 * `<slot>`. What the guide pages need on top of that — a contents column, an outline — is
 * `app/routes/guide/layout.tsx`, which fills this `body` hole and leaves holes of its own. The
 * landing page and the playground are outside that subtree and get this document alone.
 *
 * The search form is a `GET` to a route, which is what lets it sit in a layout that ships no
 * JavaScript of its own: there is nothing to initialise and no index to fetch.
 */
export default fragment(({ title, description, css, runtime, heading, lede, nav, body }: ShellProps) => (
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
          <form class="find" method="get" action="/search" role="search">
            <input type="search" name="q" placeholder="Search" aria-label="Search this site" />
            <button type="submit">Search</button>
          </form>
        </header>
        <main>
          <h1>{heading}</h1>
          <p class="lede">{lede}</p>
          <slot name="body">{body}</slot>
        </main>
        <footer class="foot">
          <p>
            Every example on this site is a fragment this application compiled. The source you read is the
            file that produced the output beside it.
          </p>
        </footer>
      </body>
    </html>
  </>
))
