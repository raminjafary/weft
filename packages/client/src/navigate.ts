/**
 * A route fetched, resolved, and painting nothing — an epoch, one level up.
 *
 * An epoch stages values into slots of the page you are on: any number of them coexist with
 * what is live, and one commit flips them together. The thing it cannot stage is a *different*
 * page, because a staged write names a region and a region only exists once its route has been
 * rendered. So the same separation is made again over whole routes: the answer for a route you
 * have not gone to yet is held here, keyed by its URL, and committing it is what a navigation
 * is.
 *
 * Three properties are the same ones epochs have, and for the same reason. Staging cannot
 * disturb the present, because nothing here touches the document. A staged route that is never
 * committed costs a request and no paint. And a commit is one step rather than a fetch and a
 * render, which is the whole of what makes a navigation instant rather than fast.
 *
 * Deliberately not a router and deliberately not DOM-aware. What a staged route *is* — a parsed
 * document, a set of frames, a value set — is the caller's, so the same model serves a document
 * prefetch, a channel that answers with slots, and a test with strings.
 */
export type StageState = 'none' | 'fetching' | 'ready' | 'failed'

export interface StagingOptions<T> {
  /**
   * Fetch the route's answer. Given an `AbortSignal` because a staged route that is evicted,
   * discarded, or superseded is one nobody is going to look at, and a request nobody will read
   * is bytes taken from the page that is on screen.
   */
  load(url: string, signal: AbortSignal): Promise<T | null>
  /**
   * How many routes may be staged at once. Every one of them is a render the server performed
   * for a page that may never be asked for, so the ceiling is low on purpose and the oldest
   * goes first.
   */
  max?: number
  /**
   * How long a resolved answer may be committed after it arrived. A staged route is a render
   * from a moment in the past; past this it is discarded and re-staged rather than painted,
   * because a page that shows a five-minute-old answer instantly is worse than one that waits.
   */
  ttlMs?: number
  now?(): number
}

interface Entry<T> {
  state: Exclude<StageState, 'none'>
  value: T | null
  /** When the answer resolved. Zero while it is still in flight. */
  at: number
  settled: Promise<T | null>
  abort: AbortController
}

export interface Claimed<T> {
  value: T | null
  /** `staged` was already resolved, `awaited` had to wait for it, `cold` was never staged. */
  how: 'staged' | 'awaited' | 'cold'
}

export interface Staging<T> {
  /** Begin staging, or join the staging already in flight for this URL. Paints nothing. */
  stage(url: string): Promise<T | null>
  /** The resolved answer, if there is one and it has not expired. Never a stale one. */
  ready(url: string): T | undefined
  /**
   * What a click asks for: the staged answer if it is there, the one in flight if it is not,
   * and a null the caller turns into a real navigation if there is neither.
   */
  claim(url: string): Promise<Claimed<T>>
  state(url: string): StageState
  discard(url: string): boolean
  clear(): void
  /** URLs currently staged, in the order they were staged. */
  readonly open: string[]
  readonly staged: number
  readonly awaited: number
  readonly cold: number
}

export const DEFAULT_STAGING: Required<Pick<StagingOptions<unknown>, 'max' | 'ttlMs'>> = {
  max: 4,
  ttlMs: 30_000,
}

export function createStaging<T>(options: StagingOptions<T>): Staging<T> {
  const max = options.max ?? DEFAULT_STAGING.max
  const ttlMs = options.ttlMs ?? DEFAULT_STAGING.ttlMs
  const now = options.now ?? ((): number => Date.now())
  const open = new Map<string, Entry<T>>()
  let staged = 0
  let awaited = 0
  let cold = 0

  const drop = (url: string): boolean => {
    const entry = open.get(url)
    if (!entry) return false
    entry.abort.abort()
    open.delete(url)
    return true
  }

  const expired = (entry: Entry<T>): boolean =>
    entry.state === 'ready' && entry.at > 0 && now() - entry.at > ttlMs

  const begin = (url: string): Entry<T> => {
    const abort = new AbortController()
    const entry: Entry<T> = {
      state: 'fetching',
      value: null,
      at: 0,
      abort,
      settled: undefined as unknown as Promise<T | null>,
    }
    entry.settled = options
      .load(url, abort.signal)
      .then((value) => {
        // An aborted load is not an answer, and writing it back would resurrect an entry
        // something has already decided nobody is waiting for.
        if (abort.signal.aborted) return null
        entry.state = value === null ? 'failed' : 'ready'
        entry.value = value
        entry.at = now()
        return value
      })
      .catch(() => {
        entry.state = 'failed'
        entry.value = null
        entry.at = now()
        return null
      })
    open.set(url, entry)
    // Oldest first, because the newest is the one the reader is most likely on their way to.
    while (open.size > max) {
      const first = open.keys().next().value
      if (first === undefined || first === url) break
      drop(first)
    }
    return entry
  }

  return {
    get open() {
      return [...open.keys()]
    },
    get staged() {
      return staged
    },
    get awaited() {
      return awaited
    },
    get cold() {
      return cold
    },

    stage(url) {
      const held = open.get(url)
      if (held && !expired(held) && held.state !== 'failed') return held.settled
      if (held) drop(url)
      return begin(url).settled
    },

    ready(url) {
      const entry = open.get(url)
      if (!entry || entry.state !== 'ready' || expired(entry)) return undefined
      return entry.value ?? undefined
    },

    state(url) {
      const entry = open.get(url)
      if (!entry) return 'none'
      return expired(entry) ? 'none' : entry.state
    },

    async claim(url) {
      const entry = open.get(url)
      if (!entry || expired(entry) || entry.state === 'failed') {
        if (entry) drop(url)
        cold++
        return { value: null, how: 'cold' }
      }
      const how = entry.state === 'ready' ? 'staged' : 'awaited'
      const value = await entry.settled
      // Committed or refused, a claimed route is spent: what the page shows next is the page
      // itself, and holding the markup it was built from is a second copy of the document.
      open.delete(url)
      if (value === null) {
        cold++
        return { value: null, how: 'cold' }
      }
      if (how === 'staged') staged++
      else awaited++
      return { value, how }
    },

    discard(url) {
      return drop(url)
    },

    clear() {
      for (const url of open.keys()) drop(url)
    },
  }
}

export interface LinkFacts {
  href: string
  /** `target`, `rel` and `download` as the markup wrote them. A link that says it leaves is left. */
  target?: string
  rel?: string
  download?: boolean
}

export interface ClickFacts {
  /** True for anything but a plain primary click: the reader is asking for a tab, not a page. */
  modified?: boolean
  button?: number
}

/**
 * Whether this framework may answer a link itself, decided on the markup rather than on a
 * heuristic.
 *
 * Every no here is a case where taking the click would do something the reader did not ask for:
 * another origin is not this application's to render, a `target` or a `download` is a request
 * for a different destination entirely, and `rel="external"` is an author saying so in as many
 * words. A hash on the same path is the browser's own scrolling and is left alone.
 */
export function navigable(link: LinkFacts, here: string): boolean {
  if (link.download) return false
  if (link.target && link.target !== '_self') return false
  if ((link.rel ?? '').split(/\s+/).includes('external')) return false
  let url: URL
  let from: URL
  try {
    from = new URL(here)
    url = new URL(link.href, here)
  } catch {
    return false
  }
  if (url.origin !== from.origin) return false
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  // The same document with a different fragment: the browser scrolls, and a swap would throw
  // away the position it was about to move to.
  if (url.pathname === from.pathname && url.search === from.search && url.hash) return false
  return true
}

/** A plain primary click. Anything else belongs to the browser. */
export function plainClick(click: ClickFacts): boolean {
  return !click.modified && (click.button ?? 0) === 0
}

/** The key a staged route is held under: absolute, and without the fragment the server never sees. */
export function stagingKey(href: string, here: string): string {
  const url = new URL(href, here)
  url.hash = ''
  return url.href
}
