import { fragment, raw } from 'weft'

/**
 * Everything the framework knows about a request that could not be answered.
 *
 * This is the contract an application's `app/layouts/error.tsx` is written against: write a file
 * with that name and it is handed exactly these values, in place of this one, for both a 404 and a
 * 500. There is nothing to register — a named layout is discovered the way every other document is,
 * and `error` is the name the framework looks for.
 */
export interface ErrorProps {
  title: string
  description: string
  css: string
  /** `404`, `500`. A string because a hole is filled, never compared. */
  status: string
  /** The framework's own name for what happened: `E_NO_ROUTE`, `E_RENDER_FAILED`. */
  code: string
  /** One sentence, for somebody deciding what to do next rather than debugging it. */
  detail: string
  /** The path that was asked for. Empty on a failure that was not about a path. */
  path: string
  /** `weft-error-subject`, or `weft-hidden` when there is no path to name. */
  pathClass: string
  /**
   * The stack, in development only.
   *
   * A trace is the one useful thing here while you are building and the one thing that must never
   * go out otherwise: it names files, line numbers and often the shape of the data being handled.
   * In `weft start` it is empty and `stackClass` hides the block that would have held it.
   */
  stack: string
  stackClass: string
  backHref: string
  backLabel: string
}

/**
 * The page the framework serves when there is no page, or when one failed.
 *
 * Deliberately four lines and a way out. An error page's whole job is to say what happened and what
 * to do next, and everything else on it competes with those two — which is why this one does *not*
 * list the route table. That list was written for the person building the application and shown to
 * everyone who mistyped a URL; on a deployment it is a map of the site handed to whoever asks for a
 * path that does not exist. `weft routes` prints it for the one audience it was ever for.
 *
 * The mark is inline because an error page cannot depend on a request succeeding: a 404 that
 * fetched a logo would be a 404 with a broken image on it.
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
  }: ErrorProps) => (
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
          <link rel="stylesheet" href={css} />
        </head>
        <body>
          <main class="weft-main weft-error">
            <svg class="weft-error-mark" width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">
              <g fill="currentColor" opacity="0.4">
                <rect x="4.6" y="2" width="2" height="20" rx="1" />
                <rect x="11" y="2" width="2" height="20" rx="1" />
                <rect x="17.4" y="2" width="2" height="20" rx="1" />
              </g>
              <g fill="currentColor">
                <rect x="1" y="7" width="22" height="2" rx="1" />
                <rect x="1" y="15" width="3.6" height="2" rx="1" />
                <rect x="6.6" y="15" width="4.4" height="2" rx="1" />
                <rect x="13" y="15" width="4.4" height="2" rx="1" />
                <rect x="19.4" y="15" width="3.6" height="2" rx="1" />
              </g>
            </svg>
            <p class="weft-error-status">
              {status} <span class="weft-error-code">{code}</span>
            </p>
            <h1>{title}</h1>
            <p class="weft-lede">{detail}</p>
            <p class={pathClass}>
              <code>{path}</code>
            </p>
            <p class="weft-row">
              <a class="weft-button" data-variant="primary" href={backHref}>
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
