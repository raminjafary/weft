import { fragment, raw } from '@weftjs/core'

interface Props {
  title: string
  description: string
  css: string
  status: string
  code: string
  detail: string
  path: string
  pathClass: string
  stack: string
  stackClass: string
  backHref: string
  backLabel: string
}

/**
 * This site's 404 and 500, replacing the framework's own. A named layout under `app/layouts/` —
 * the framework looks for one called `error` and renders it instead of its default, handed the
 * values `packages/weft/src/assets/error.tsx` documents.
 *
 * Deliberately not the site's full chrome — no header, nav, or search box before the sentence that
 * matters. The mark is inline because an error page can't depend on a request succeeding.
 * `stack` is empty outside `weft dev`, and `stackClass` hides the block that would have held it.
 */
export default fragment(
  ({
    title,
    description,
    css,
    status,
    code,
    detail,
    path,
    pathClass,
    stack,
    stackClass,
    backHref,
    backLabel,
  }: Props) => (
    <>
      {raw('<!doctype html>')}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width,initial-scale=1" />
          <meta name="color-scheme" content="light dark" />
          <meta name="robots" content="noindex" />
          <title>{title}</title>
          <meta name="description" content={description} />
          <link rel="icon" href="/mark.svg" type="image/svg+xml" />
          <link rel="stylesheet" href={css} />
        </head>
        <body>
          <main class="lost">
            <a class="brand lost-brand" href="/">
              <svg class="mark" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
                <g class="mark-warp">
                  <rect x="4.6" y="2" width="2" height="20" rx="1" />
                  <rect x="11" y="2" width="2" height="20" rx="1" />
                  <rect x="17.4" y="2" width="2" height="20" rx="1" />
                </g>
                <g class="mark-weft">
                  <rect x="1" y="7" width="22" height="2" rx="1" />
                  <rect x="1" y="15" width="3.6" height="2" rx="1" />
                  <rect x="6.6" y="15" width="4.4" height="2" rx="1" />
                  <rect x="13" y="15" width="4.4" height="2" rx="1" />
                  <rect x="19.4" y="15" width="3.6" height="2" rx="1" />
                </g>
              </svg>
              <span class="wordmark">weft</span>
            </a>
            <p class="lost-status">
              <span class="lost-number">{status}</span>
              <span class="badge">{code}</span>
            </p>
            <h1>{title}</h1>
            <p class="lede">{detail}</p>
            <p class={pathClass}>
              <code>{path}</code>
            </p>
            <p class="lost-do">
              <a class="btn btn-primary" href={backHref}>
                {backLabel}
              </a>
            </p>
            <pre class={stackClass}>
              <code>{stack}</code>
            </pre>
          </main>
        </body>
      </html>
    </>
  ),
)
