/** A route fetched, resolved, and painting nothing — an epoch, one level up. See `spec/client/navigation.md`. */
export type StageState = 'none' | 'fetching' | 'ready' | 'failed'

/** What staging needs: how to fetch a route, and how much to keep. */
export interface StagingOptions<T> {
  /** Fetch the route's answer. Given an `AbortSignal` since an evicted or superseded staged route is one nobody will read. */
  load(url: string, signal: AbortSignal): Promise<T | null>
  /** How many routes may be staged at once. See `spec/client/navigation.md`. */
  max?: number
  /** How long a resolved answer may be committed after it arrived. See `spec/client/navigation.md`. */
  ttlMs?: number
  /** Called for an answer dropped without being committed — evicted, expired, discarded. May need to release more than the value itself. */
  release?(value: T): void
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

/** A staged route being taken: the value, and whether it was ready before the click. */
export interface Claimed<T> {
  value: T | null
  /** `staged` was already resolved, `awaited` had to wait for it, `cold` was never staged. */
  how: 'staged' | 'awaited' | 'cold'
}

/** Routes fetched and painted nowhere. An epoch one level up: keyed by URL, capped, claimed by a click. */
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

/** How many routes are held staged, and for how long. A staged route nobody clicks is memory. */
export const DEFAULT_STAGING: Required<Pick<StagingOptions<unknown>, 'max' | 'ttlMs'>> = {
  max: 4,
  ttlMs: 30_000,
}

/** A staging table. Nothing here touches the DOM; a claim is what a caller paints. */
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
    if (entry.value !== null) options.release?.(entry.value)
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
    // Oldest first. See `spec/client/navigation.md`.
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

/** What a link is, reduced to what decides whether the framework may answer the click. */
export interface LinkFacts {
  href: string
  /** `target`, `rel` and `download` as the markup wrote them. A link that says it leaves is left. */
  target?: string
  rel?: string
  download?: boolean
}

/** What a click is: the modifiers that mean the reader asked the browser, not this framework. */
export interface ClickFacts {
  /** True for anything but a plain primary click: the reader is asking for a tab, not a page. */
  modified?: boolean
  button?: number
}

/** Whether this framework may answer a link itself, decided on the markup rather than on a heuristic. See `spec/client/navigation.md`. */
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

/** What a `NAV` frame says: whether a route can be staged as regions, and what those regions are. See `spec/client/navigation.md`. */
export interface StagedNav {
  at: string
  route: string
  form: 'slots' | 'document'
  epoch?: string
  /** The regions that follow this frame, by slot name. */
  slots: string[]
  title?: string
  css?: string
  /** Where readers of the staged route go next, from a profile. Worth staging once it commits. */
  next: string[]
  why?: string
}

/** The frame that asks for a route: the design's `WARM`, at the grain it always described. */
export function warmFrame(at: string, epoch: string): { kind: string; header: Record<string, string> } {
  return { kind: 'WARM', header: { at, epoch } }
}

/** Navigation's own frame handler, passed to the channel as `onFrame`. See `spec/kernel/budgets.md`. */
function header(
  frame: { header: Record<string, string | number | boolean> },
  key: string,
): string | undefined {
  const value = frame.header[key]
  return value === undefined ? undefined : String(value)
}

/** The frames a staged navigation sends: what to stage, and what the client already holds. */
export function navFrames(
  onNav?: (nav: StagedNav) => void,
): (
  frame: { kind: string; header: Record<string, string | number | boolean> },
  applied: { navs: StagedNav[] },
) => void {
  const text = header
  return (frame, applied) => {
    if (frame.kind !== 'NAV') return
    const nav: StagedNav = {
      at: text(frame, 'at') ?? '',
      route: text(frame, 'route') ?? '',
      form: text(frame, 'form') === 'slots' ? 'slots' : 'document',
      ...(text(frame, 'epoch') ? { epoch: text(frame, 'epoch') as string } : {}),
      slots: (text(frame, 's') ?? '').split(',').filter(Boolean),
      ...(text(frame, 'title') ? { title: text(frame, 'title') as string } : {}),
      ...(text(frame, 'css') ? { css: text(frame, 'css') as string } : {}),
      next: (text(frame, 'next') ?? '').split(',').filter(Boolean),
      ...(text(frame, 'why') ? { why: text(frame, 'why') as string } : {}),
    }
    applied.navs.push(nav)
    onNav?.(nav)
  }
}
