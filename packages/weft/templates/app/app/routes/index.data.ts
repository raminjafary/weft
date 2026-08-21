import { asset, defineRoute } from 'weft'

/**
 * What this route declares. Placement, cache policy and data — and deliberately no cache key,
 * because keys are derived from what the compiler saw the page read and a key you can hand-write
 * is a key that can disagree with the code.
 */
export default defineRoute({
  head: { title: '__NAME__', description: 'A weft application.' },
  // This page reads nothing per-request, so it is a shared entry. Declaring `private` here would
  // be accepted; declaring `public` on a page that read identity would fail the build.
  cache: { class: 'public', ttl: '1h' },
  load: () => ({
    name: '__NAME__',
    // A revved URL: the digest of the file is in the path, so it is immutable for a year. Writing
    // '/logo.svg' by hand also works and is served with no-store, because a URL that does not
    // name its contents cannot be cached.
    logo: asset('/logo.svg'),
    steps: [
      {
        n: '01',
        what: 'Edit this page. The dev server rebuilds without restarting.',
        where: 'app/routes/index.tsx',
      },
      {
        n: '02',
        what: 'Add a page. The file name is the route; no table to register it in.',
        where: 'app/routes/about.tsx',
      },
      { n: '03', what: 'Give it data, a cache policy and a head.', where: 'app/routes/about.data.ts' },
      { n: '04', what: 'Write a mutation. It works with JavaScript off.', where: 'app/intents/' },
      { n: '05', what: 'See the plan the framework generated for a route.', where: 'weft why /' },
      { n: '06', what: 'Build it. Sealed templates, the plan, and revved assets.', where: 'weft build' },
    ],
  }),
})
