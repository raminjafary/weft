import { defineConfig } from 'weft'

/**
 * The documentation site, as a deployment.
 *
 * It binds nothing but the defaults, and that is the point worth making twice: a site whose every
 * page is server-rendered, cached by what its fragments read, and streamed needs no configuration
 * at all. The one thing declared here is the nav, because a nav derived from the route table would
 * list every guide page in the header.
 */
export default defineConfig({
  port: 4190,
  /**
   * A deploy purges the CDN in front of this site, so a document the build proved invariant can be
   * answered from the edge until the next one. Without it every navigation to a prerendered page
   * cost a round trip to the single region the deployment runs in — about a second from Europe,
   * for bytes that had been sitting in a file since the build.
   */
  documents: { shared: 31536000, stale: 86400 },
  nav: [
    { href: '/quick-start', label: 'Quick Start' },
    { href: '/guide', label: 'Guide' },
    { href: '/tutorial', label: 'Tutorial' },
    { href: '/examples', label: 'Examples' },
    { href: '/api', label: 'API' },
    { href: '/glossary', label: 'Glossary' },
    { href: '/errors', label: 'Errors' },
    { href: '/play', label: 'Playground' },
  ],
})
