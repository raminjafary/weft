/**
 * What each showcase stands for. Content, not configuration: the route table is the file tree, and
 * this is only what the index says about the pages it links to.
 */
export interface Showcase {
  href: string
  title: string
  standsFor: string
  leansOn: readonly string[]
}

export const SHOWCASES: readonly Showcase[] = [
  {
    href: '/app/ordinary/pantry',
    title: 'An ordinary page',
    standsFor:
      'Most pages. A category listing, a settings screen, a form — no streaming, no channel, no deltas, nothing clever.',
    leansOn: [
      'A component imported from another module and rendered three times, sealed once',
      'A route param, which becomes a cache key component without the plan mentioning keys',
      'Every region buffered, so the plan lowers to in-order and the out-of-order filler is never on the wire',
    ],
  },
  {
    href: '/app/feed',
    title: 'A content-heavy feed',
    standsFor: 'A news front page, a product listing, a search result — hundreds of rows, mostly shared.',
    leansOn: [
      'One sealed row template projected hundreds of times, so page weight tracks content',
      'A shared cache class, because nothing on it reads identity',
      'Deltas over a live channel: one computation serves every reader on the same base',
    ],
  },
  {
    href: '/app/cart',
    title: 'A cart, which is the hard case',
    standsFor: 'Anything signed in. One private region inside a shared document.',
    leansOn: [
      'A fragment that reads identity, so `private` is the only policy the compiler will accept',
      'An intent over the channel, staged into an epoch, answered with a delta',
      'The same intent answering a plain form post with a 303, for a client with no JavaScript',
    ],
  },
  {
    href: '/app/dashboard',
    title: 'A dashboard with slow panels',
    standsFor: 'Four independent queries of very different cost.',
    leansOn: [
      'A panel per slot, each with its own latency, cache policy and executor',
      'A data dependency, so the scheduler runs the panels in waves rather than in file order',
      'A CPU budget and an exceed policy you can change and watch',
    ],
  },
  {
    href: '/app/article',
    title: 'An article',
    standsFor: 'The case where almost nothing should ship.',
    leansOn: [
      'A fragment that reads nothing, so its class is static and its key is its content address',
      'No ttl, because there is no clock read to expire',
      'A page that is identical with JavaScript disabled',
    ],
  },
]
