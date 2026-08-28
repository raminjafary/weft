import { defineConfig } from '@weftjs/core'

/**
 * The documentation site, as a deployment.
 *
 * It binds nothing but the defaults, and that is the point worth making twice: a site whose every
 * page is server-rendered, cached by what its fragments read, and streamed needs no configuration
 * at all. The one thing declared here is the nav, because a nav derived from the route table would
 * list every guide page in the header.
 */
export default defineConfig({
  // Not 4190. That is sieve, which the WHATWG fetch standard blocks, so a browser refused every
  // channel request this site made and reported nothing — see `E_BLOCKED_PORT`.
  port: 4191,
  /**
   * A deploy purges the CDN in front of this site, so a document the build proved invariant can be
   * answered from the edge until the next one. Without it every navigation to a prerendered page
   * cost a round trip to the single region the deployment runs in — about a second from Europe,
   * for bytes that had been sitting in a file since the build.
   */
  documents: { shared: 31536000, stale: 86400 },
  /**
   * This site is a Vercel function, which terminates no upgrade and outlives no request.
   *
   * Said rather than discovered. Without it the client tries the socket, is refused, falls back to
   * a streamed GET that appears to work, and then posts to whichever instance the platform happens
   * to route to — so a navigation that should have been a delta becomes a document, intermittently
   * and for a reason nothing in the page can name. With it the channel takes turns from the first
   * request: everything the client asks for it gets, and the one thing it gives up — being told
   * about an invalidation it did not ask about — is a thing this site never had a use for, having
   * no writes at all.
   */
  channel: { hold: false },
  /**
   * Where this site is served from, which is the one thing the build cannot work out for itself.
   *
   * It is what makes `weft site` write a `sitemap.xml` — generated from the documents that were
   * actually published, so it cannot list a page that does not exist or miss one that does — and
   * what lets every page carry an absolute `<link rel="canonical">`.
   */
  site: { origin: 'https://weft-rr7.vercel.app' },
  nav: [
    { href: '/quick-start', label: 'Quick Start' },
    { href: '/guide', label: 'Guide' },
    { href: '/tutorial', label: 'Tutorial' },
    { href: '/examples', label: 'Examples' },
    { href: '/reference', label: 'Reference' },
    { href: '/api', label: 'API' },
    { href: '/glossary', label: 'Glossary' },
    { href: '/errors', label: 'Errors' },
    { href: '/play', label: 'Playground' },
  ],
})
