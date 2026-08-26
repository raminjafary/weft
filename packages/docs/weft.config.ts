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
