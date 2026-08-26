/**
 * The part of the plan this client did not have, and what it is for.
 *
 * A staged navigation asks the server to render a route the reader has not clicked — and the answer
 * can be "you cannot have this as regions, fetch the document": a different shell has different
 * holes. That answer costs a round trip and a whole server render to arrive at, and it is knowable
 * in advance from one fact about the target, which is which document it renders into.
 *
 * So the client keeps what it has been told. `WARM plan=<prefix>` asks about a subtree; a `PLAN`
 * frame also arrives unasked when a channel opens, carrying this page's own route and the routes
 * readers of it go to next — the profile's transitions, reaching a page that arrived by an ordinary
 * document request rather than only one that already staged something.
 *
 * Deliberately not a router. Nothing here decides what a click does or touches the DOM: it answers
 * "what do I know about this URL", and every use of the answer is somewhere else.
 */
export interface KnownRoute {
  pattern: string
  /** The shell template's version. The client's only question is whether it matches its own. */
  shell: string
  /** Whether that shell is the one this page is in, as the server decided it. */
  shared: boolean
  slots?: readonly string[]
  css?: string
  tpl?: readonly string[]
  next?: readonly string[]
  /**
   * Whether staging this route from the page the client is on is worth the request.
   *
   * `false` only when a recording says so: readers of this page were described this route and did
   * not follow it. Absent means unmeasured, and unmeasured stages — the same rule delivery and
   * discovery follow, so a recording of last Tuesday cannot quietly turn staging off for a route it
   * never saw.
   *
   * The decision is the server's because only the server has the recording, and it is per *source*
   * page rather than per target: readers of a product page go to the cart, and readers of the cart
   * do not go back.
   */
  stage?: boolean
}

export interface Known {
  /** Record what a PLAN carried. A pattern arriving twice replaces what was held for it. */
  learn(routes: readonly KnownRoute[]): void
  /** What is known about a URL, by the most specific pattern that matches it. */
  route(href: string, here?: string): KnownRoute | undefined
  /** Prefixes already asked about, so a second hover over the same subtree asks nothing. */
  asked(prefix: string): boolean
  ask(prefix: string): void
  readonly patterns: string[]
  readonly size: number
}

export function createKnown(): Known {
  const routes = new Map<string, KnownRoute>()
  const prefixes = new Set<string>()

  return {
    get patterns() {
      return [...routes.keys()]
    },
    get size() {
      return routes.size
    },
    learn(incoming) {
      for (const route of incoming) routes.set(route.pattern, route)
    },
    asked(prefix) {
      return prefixes.has(prefix)
    },
    ask(prefix) {
      prefixes.add(prefix)
    },
    route(href, here) {
      let path: string
      try {
        path = new URL(href, here ?? 'http://weft.local').pathname
      } catch {
        return undefined
      }
      let best: KnownRoute | undefined
      let bestRank = -1
      for (const route of routes.values()) {
        const rank = rankOf(route.pattern, path)
        if (rank > bestRank) {
          best = route
          bestRank = rank
        }
      }
      return best
    },
  }
}

/**
 * How specifically a pattern matches a path, or -1 for no match.
 *
 * The server's matcher decides by specificity rather than by declaration order, and a client that
 * decided differently would answer a click on the strength of a route the server would not have
 * chosen. So the same rule, in the smallest form that produces the same answer: a static segment
 * beats a param, a param beats the wildcard, compared left to right.
 */
export function rankOf(pattern: string, path: string): number {
  const want = segments(pattern)
  const have = segments(path)
  const wild = want[want.length - 1] === '*'
  const fixed = wild ? want.length - 1 : want.length
  if (wild ? have.length < fixed : have.length !== fixed) return -1

  let rank = 0
  for (let i = 0; i < fixed; i++) {
    const piece = want[i] as string
    if (piece.startsWith(':')) {
      rank = rank * 4 + 2
      continue
    }
    if (piece !== have[i]) return -1
    rank = rank * 4 + 3
  }
  return wild ? rank * 4 + 1 : rank
}

function segments(path: string): string[] {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed === '' ? [] : trimmed.slice(1).split('/')
}

/** The frame that asks about a subtree: the design's `router.discover('/checkout/*')`, on the wire. */
export function discoverFrame(prefix: string): { kind: string; header: Record<string, string> } {
  return { kind: 'WARM', header: { plan: prefix } }
}

export interface PlanArrival {
  /** What was asked about. Empty for the frame that follows the handshake. */
  prefix: string
  routes: KnownRoute[]
  /** False when the server truncated the answer, so this is not the whole subtree. */
  complete: boolean
}

/**
 * Discovery's own frame handler, passed to the channel as part of `onFrame`.
 *
 * Here rather than in the channel's switch for the reason `navFrames` is: a frame kind belongs to
 * the capability that introduced it, so a page that never discovers anything carries neither the
 * parse nor the registry.
 */
export function planFrames(
  known: Known,
  onPlan?: (arrival: PlanArrival) => void,
): (frame: { kind: string; header: Record<string, string | number | boolean>; body?: Uint8Array }) => void {
  return (frame) => {
    if (frame.kind !== 'PLAN') return
    let routes: KnownRoute[] = []
    if (frame.body?.length) {
      try {
        routes = JSON.parse(new TextDecoder().decode(frame.body)) as KnownRoute[]
      } catch {
        // A body this build cannot read is a hint, and a hint that cannot be read is not an error
        // worth breaking a page over: every path that uses this works without it.
        return
      }
    }
    known.learn(routes)
    const prefix = frame.header['p']
    onPlan?.({
      prefix: prefix === undefined ? '' : String(prefix),
      routes,
      complete: frame.header['complete'] !== false && frame.header['complete'] !== 'false',
    })
  }
}
