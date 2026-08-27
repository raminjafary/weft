import { fragment, raw } from '@weft/core'
import Mark from './fragments/chrome/mark.tsx'

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
  nav: NavItem[]
  body: string
  /** `ir 2.6.0 · warp 1.8.0`, from the constants a build stamps. See `lib/shell.ts`. */
  versions: string
  repo: string
  /** Theme restore and the scripting flag, inline so both land before the first frame. */
  boot: string
  /** The framework's scroll restore, inlined so it runs before paint. See `SCROLL_PRELUDE`. */
  prelude: string
}

/**
 * The document, and one slot.
 *
 * A documentation site is the case where a nested layout earns its keep, so this file stops at the
 * chrome every page shares: the head, the header, one `<slot>`, the footer. The heading and the
 * lede are *not* here — the design puts them inside the article column, to the right of the
 * contents rail, so the section layouts own them and the two pages with no rail render their own.
 *
 * The search box is a `GET` to a route, which is what lets it sit in a layout that ships no
 * JavaScript of its own: there is nothing to initialise and no index to fetch. `app/client.ts`
 * upgrades it to a ⌘K dropdown afterwards, and the form underneath it keeps working either way.
 */
export default fragment(
  ({ title, description, css, runtime, nav, body, versions, repo, boot, prelude }: ShellProps) => (
    <>
      {raw('<!doctype html>')}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width,initial-scale=1" />
          {/*
          Declared here, in the head, rather than only in the stylesheet.

          The palette below is chosen by `prefers-color-scheme`, but a browser that has not been told
          the page handles dark paints its default white canvas first — so every refresh in dark mode
          was a white frame, then the real background. This tag is read before the stylesheet is even
          fetched, which is the only place early enough to prevent that frame rather than shorten it.
        */}
          <meta name="color-scheme" content="light dark" />
          <title>{title}</title>
          <meta name="description" content={description} />
          <link rel="icon" href="/mark.svg" type="image/svg+xml" />
          <link rel="preconnect" href="https://fonts.googleapis.com" />
          <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
          <link
            rel="stylesheet"
            href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
          />
          <link rel="stylesheet" href={css} />
          <script type="module" src={runtime} />
          {raw(boot)}
        </head>
        <body>
          <a class="skip" href="#main">
            Skip to content
          </a>
          <header class="top">
            <div class="top-in">
              <a class="brand" href="/">
                <Mark size="20" cls="mark" />
                <span class="wordmark">weft</span>
              </a>
              <nav class="top-nav" aria-label="Sections">
                {nav.map((item) => (
                  <a href={item.href} data-current={item.current}>
                    {item.label}
                  </a>
                ))}
              </nav>
              <div class="top-end">
                <form class="find" method="get" action="/search" role="search">
                  <svg
                    class="find-icon"
                    width="13"
                    height="13"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.6"
                    aria-hidden="true"
                  >
                    <circle cx="6.8" cy="6.8" r="4.6" />
                    <path d="M10.3 10.3 14 14" />
                  </svg>
                  <input
                    id="q"
                    type="search"
                    name="q"
                    placeholder="Search"
                    autocomplete="off"
                    aria-label="Search this site"
                  />
                  <kbd class="find-key" aria-hidden="true">
                    ⌘K
                  </kbd>
                </form>
                <span class="ver" title="The wire formats this build stamps on a document">
                  {versions}
                </span>
                <a class="top-icon" href={repo} aria-label="Repository" rel="noreferrer">
                  <svg width="17" height="17" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                    <path d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38v-1.35c-2.23.48-2.7-1.07-2.7-1.07-.36-.93-.89-1.18-.89-1.18-.73-.5.05-.49.05-.49.8.06 1.23.83 1.23.83.71 1.22 1.87.87 2.33.67.07-.52.28-.87.5-1.07-1.78-.2-3.65-.89-3.65-3.95 0-.87.31-1.59.83-2.15-.09-.2-.36-1.02.08-2.13 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.03 2.2-.82 2.2-.82.44 1.11.17 1.93.08 2.13.52.56.83 1.28.83 2.15 0 3.07-1.87 3.75-3.66 3.95.29.25.54.73.54 1.48v2.19c0 .21.14.46.55.38A8 8 0 0 0 8 0Z" />
                  </svg>
                </a>
                <button class="top-icon theme" type="button" data-theme-toggle aria-label="Switch theme">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.5"
                    aria-hidden="true"
                  >
                    <path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8Z" />
                  </svg>
                </button>
              </div>
            </div>
          </header>
          <main id="main">
            <slot name="body">{body}</slot>
          </main>
          <footer class="foot">
            <div class="foot-in">
              <Mark size="18" cls="mark quiet" />
              <p>
                Every example on this site is a fragment this application compiled. The source you read is the
                file that produced the output beside it.
              </p>
            </div>
          </footer>
          {raw(prelude)}
        </body>
      </html>
    </>
  ),
)
