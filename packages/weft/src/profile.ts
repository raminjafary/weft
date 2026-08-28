import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * A plan generated from measurement rather than from a convention. Record what happened, and let
 * the recording decide the parts of the plan that are about time. See `spec/plan/profile.md`.
 */
/** Bumped to '2' when a recording started counting discoveries. See `spec/plan/profile.md`. */
export const PROFILE_VERSION = '2'

/** What one slot cost, over every render the recording saw. Renders and cache hits kept apart. */
export interface SlotObservation {
  /** Renders observed. A hit is not a render, which is why this is not the request count. */
  renders: number
  /** Milliseconds to produce the bytes, including the loader. */
  p50: number
  p95: number
  /** The largest render seen, in bytes. Streaming a small region buys nothing. */
  bytes: number
  /** Requests that did not render it, because the store already had it. */
  hits: number
}

/** What one route cost, and where its readers came from — which is what a `Referer` says. */
export interface RouteObservation {
  requests: number
  slots: Record<string, SlotObservation>
  /** Which route a reader came from, by pattern, and how often. What a nav should stage. */
  from: Record<string, number>
  /**
   * Times this route was *described* to a client that had not been to it, and times a description
   * was then used. See `spec/plan/profile.md`.
   */
  described: number
  followed: number
}

/** A recording, as written to disk. Versioned: an older one is ignored rather than half-read. */
export interface Profile {
  version: string
  /** When it was written, absolute, so an old profile can say how old it is. */
  recordedAt: number
  /** Wall-clock the recorder was collecting for. */
  forMs: number
  routes: Record<string, RouteObservation>
}

/** Where a recording is written, inside the out directory so it travels with the build. */
export const PROFILE_FILE = 'profile.json'

/** How many renders a slot needs before its number decides anything. */
export const MIN_SAMPLES = 8
/** A slot slower than this is worth streaming, if something on the page is faster. */
export const SLOW_MS = 40
/** A region smaller than this gains nothing from arriving separately. */
export const MIN_STREAM_BYTES = 512
/** A transition seen at least this often, and this much of a route's departures, is worth staging. */
export const MIN_TRANSITIONS = 4
/** The share of arrivals a source needs before staging from it is worth a speculative fetch. */
export const MIN_SHARE = 0.15
/** How many times a route has to have been described before the number says anything. */
export const MIN_DESCRIBED = 8
/** How often a description has to be followed to be worth sending. Lower than `MIN_SHARE`,
 * deliberately: describing is cheap and staging runs loaders. See `spec/plan/profile.md`. */
export const MIN_FOLLOW_SHARE = 0.2

interface Sample {
  ms: number[]
  bytes: number
  hits: number
}

/** What every render, cache hit and description reports to while a process is recording. */
export interface Recorder {
  /** A document request arrived for this route. */
  request(route: string, from?: string): void
  /** This route was described to a client that had not been to it, in a `PLAN` frame. Recorded per
   * described route rather than per frame. */
  described(route: string): void
  /** A described route was then asked for. */
  followed(route: string): void
  /** A slot rendered, which means the store did not already have it. */
  render(route: string, slot: string, ms: number, bytes: number): void
  /** A slot the store answered for. */
  hit(route: string, slot: string): void
  /** What has been observed so far, as the file would be written. */
  profile(): Profile
  readonly renders: number
}

/**
 * The recorder, which is deliberately not a telemetry port: a `TelemetryPort` sees a slot name and
 * no route, and the front door knows both.
 */
export function createRecorder(now: () => number = () => Date.now()): Recorder {
  const started = now()
  const routes = new Map<
    string,
    {
      requests: number
      from: Map<string, number>
      slots: Map<string, Sample>
      described: number
      followed: number
    }
  >()
  let renders = 0

  const of = (route: string): NonNullable<ReturnType<typeof routes.get>> => {
    let held = routes.get(route)
    if (!held) {
      held = { requests: 0, from: new Map(), slots: new Map(), described: 0, followed: 0 }
      routes.set(route, held)
    }
    return held
  }

  const sample = (route: string, slot: string): Sample => {
    const held = of(route)
    let found = held.slots.get(slot)
    if (!found) {
      found = { ms: [], bytes: 0, hits: 0 }
      held.slots.set(slot, found)
    }
    return found
  }

  return {
    get renders() {
      return renders
    },
    request(route, from) {
      const held = of(route)
      held.requests++
      if (from && from !== route) held.from.set(from, (held.from.get(from) ?? 0) + 1)
    },
    render(route, slot, ms, bytes) {
      renders++
      const found = sample(route, slot)
      // Bounded to the most recent thousand: describes the deployment as it is now.
      found.ms.push(ms)
      if (found.ms.length > 1_000) found.ms.shift()
      found.bytes = Math.max(found.bytes, bytes)
    },
    hit(route, slot) {
      sample(route, slot).hits++
    },
    described(route) {
      of(route).described++
    },
    followed(route) {
      of(route).followed++
    },
    profile() {
      const out: Profile['routes'] = {}
      for (const [route, held] of routes) {
        const slots: Record<string, SlotObservation> = {}
        for (const [slot, found] of held.slots) {
          const sorted = [...found.ms].sort((a, b) => a - b)
          slots[slot] = {
            renders: sorted.length,
            p50: round(percentile(sorted, 0.5)),
            p95: round(percentile(sorted, 0.95)),
            bytes: found.bytes,
            hits: found.hits,
          }
        }
        out[route] = {
          requests: held.requests,
          slots,
          from: Object.fromEntries(held.from),
          described: held.described,
          followed: held.followed,
        }
      }
      return { version: PROFILE_VERSION, recordedAt: now(), forMs: now() - started, routes: out }
    },
  }
}

function percentile(sorted: readonly number[], at: number): number {
  if (!sorted.length) return 0
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * at))
  return sorted[index] as number
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10
}

/** What the numbers decided about one slot's delivery, and the sentence explaining it. */
export interface SlotDecision {
  route: string
  slot: string
  /** What the plan should say, or null where the profile has nothing to say about it. */
  delivery: 'stream' | 'buffered' | null
  prio?: number
  /** The evidence, in one line. This is what `weft profile` prints and `weft why` attributes. */
  because: string
}

/** One route's decisions: its slots' delivery, and which pages it is worth staging from. */
export interface RouteDecision {
  route: string
  slots: SlotDecision[]
  /** Routes worth staging from this one, most likely first. */
  stage: string[]
}

/** Whether describing this route to a client that has not been to it pays for the bytes. */
export interface DiscoverDecision {
  route: string
  /** Whether describing this route to a client that has not been to it is worth the bytes. */
  describe: boolean
  described: number
  followed: number
  because: string
}

/**
 * Everything a recording decided, and what it refused to decide. Placement, cache classes and keys
 * are untouched — a recording has no standing over what the compiler inferred.
 */
export interface Decisions {
  routes: RouteDecision[]
  /**
   * Which routes are worth describing before anybody looks at them. Too few descriptions to say is
   * absent rather than defaulted. See `spec/plan/profile.md`.
   */
  discover: DiscoverDecision[]
  /** Slots the profile saw too little of to say anything about. */
  thin: { route: string; slot: string; renders: number }[]
  /** What a profile cannot decide here, and why. Printed rather than left as a silence. */
  refused: { what: string; why: string }[]
}

/**
 * What the numbers decide, and — as importantly — what they refuse to. See `spec/plan/profile.md`.
 */
export function decide(profile: Profile): Decisions {
  const routes: RouteDecision[] = []
  const thin: Decisions['thin'] = []

  for (const [route, observed] of Object.entries(profile.routes)) {
    const slots = Object.entries(observed.slots)
    const measured = slots.filter(([, s]) => s.renders >= MIN_SAMPLES)
    for (const [slot, s] of slots) {
      if (s.renders < MIN_SAMPLES) thin.push({ route, slot, renders: s.renders })
    }
    if (!measured.length) {
      routes.push({ route, slots: [], stage: staging(observed) })
      continue
    }

    const slowest = Math.max(...measured.map(([, s]) => s.p95))
    const fastest = Math.min(...measured.map(([, s]) => s.p95))
    // Streaming is only worth the filler when the page has a spread: if everything is slow the
    // reader waits either way, and if everything is fast there is nothing to wait for.
    const spread = slowest >= SLOW_MS && fastest < slowest / 2
    const decisions: SlotDecision[] = []

    for (const [slot, s] of measured) {
      if (!spread) {
        decisions.push({
          route,
          slot,
          delivery: 'buffered',
          because: `p95 ${s.p95}ms over ${s.renders} renders, and no region on this route is slow enough to wait behind: in-order, so the filler is not on the wire`,
        })
        continue
      }
      if (s.p95 >= SLOW_MS && s.bytes >= MIN_STREAM_BYTES) {
        decisions.push({
          route,
          slot,
          delivery: 'stream',
          prio: Math.max(0, Math.round((slowest - s.p95) / 10)),
          because: `p95 ${s.p95}ms over ${s.renders} renders, ${s.bytes} B: slow enough to arrive separately, and something on this page is at least twice as fast`,
        })
        continue
      }
      decisions.push({
        route,
        slot,
        delivery: 'buffered',
        because:
          s.bytes < MIN_STREAM_BYTES
            ? `only ${s.bytes} B: too small to be worth its own flush`
            : `p95 ${s.p95}ms over ${s.renders} renders: fast enough to buffer behind`,
      })
    }
    routes.push({ route, slots: decisions, stage: staging(observed) })
  }

  return {
    routes,
    thin,
    discover: discoveries(profile),
    refused: [
      {
        what: 'chunk packing',
        why: 'there is no bundler. Client modules are TypeScript served with their types stripped, so there are no chunks to pack — the design assumes a bundler this framework deliberately does not have',
      },
      {
        what: 'V8 compile hints',
        why: 'a template is data here, not code. There is no per-template function to hint: the renderer walks pre-encoded segments, so the hot code is the renderer and it is hot on every page already',
      },
      {
        what: 'whether a subtree is worth describing before anybody has looked at it *at all*',
        why: 'a recording can say whether a description was followed, which is what `discover` above decides. What it cannot say is anything about a prefix no client has ever asked about and no transition points at — there is no observation to make, and inventing one would be the guess this whole layer exists instead of',
      },
      {
        what: 'a cache key',
        why: 'keys come from what the compiler saw a fragment read, and a profile is not a compiler. This is the one extension point the design refuses on purpose',
      },
    ],
  }
}

/**
 * Whether describing a route pays, per route. Fewer than `MIN_DESCRIBED` descriptions gets no
 * entry, so a caller falls back to describing it — the same rule delivery follows.
 */
function discoveries(profile: Profile): DiscoverDecision[] {
  const out: DiscoverDecision[] = []
  for (const [route, observed] of Object.entries(profile.routes)) {
    const described = observed.described ?? 0
    const followed = observed.followed ?? 0
    if (described < MIN_DESCRIBED) continue
    const share = followed / described
    out.push({
      route,
      describe: share >= MIN_FOLLOW_SHARE,
      described,
      followed,
      because:
        share >= MIN_FOLLOW_SHARE
          ? `${followed} of ${described} descriptions were followed, and a description that is followed saves a round trip and a server render`
          : `${followed} of ${described} descriptions were followed, which is under ${Math.round(MIN_FOLLOW_SHARE * 100)}%: the bytes buy nothing here`,
    })
  }
  return out.sort((a, b) => b.described - a.described)
}

/** Where readers of this route go next, when enough of them go to the same place. */
function staging(observed: RouteObservation): string[] {
  const total = Object.values(observed.from).reduce((sum, n) => sum + n, 0)
  if (!total) return []
  return Object.entries(observed.from)
    .filter(([, count]) => count >= MIN_TRANSITIONS && count / total >= MIN_SHARE)
    .sort(([, a], [, b]) => b - a)
    .map(([route]) => route)
}

/**
 * The transitions, read the other way round: the profile records where a request came from, and a
 * navigation needs the opposite. Inverted once, here, rather than by every reader.
 */
export function likelyNext(profile: Profile): Record<string, string[]> {
  const forward = new Map<string, Map<string, number>>()
  for (const [to, observed] of Object.entries(profile.routes)) {
    for (const [from, count] of Object.entries(observed.from)) {
      const held = forward.get(from) ?? new Map<string, number>()
      held.set(to, (held.get(to) ?? 0) + count)
      forward.set(from, held)
    }
  }
  const out: Record<string, string[]> = {}
  for (const [from, targets] of forward) {
    const total = [...targets.values()].reduce((sum, n) => sum + n, 0)
    const worth = [...targets]
      .filter(([, count]) => count >= MIN_TRANSITIONS && count / total >= MIN_SHARE)
      .sort(([, a], [, b]) => b - a)
      .map(([route]) => route)
    if (worth.length) out[from] = worth
  }
  return out
}

/** Write the recording out. Called on the way down, so a killed process loses only the tail. */
export async function writeProfile(root: string, outDir: string, profile: Profile): Promise<string> {
  const path = join(root, outDir, PROFILE_FILE)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(profile, null, 2)}\n`)
  return path
}

/** The profile on disk, or null. A different format version is ignored rather than half-read. */
export async function readProfile(root: string, outDir: string): Promise<Profile | null> {
  try {
    const raw = await readFile(join(root, outDir, PROFILE_FILE), 'utf8')
    const parsed = JSON.parse(raw) as Profile
    return parsed.version === PROFILE_VERSION ? parsed : null
  } catch {
    return null
  }
}

/** How old a profile is, in words, because a stale one looks exactly like a current one. */
export function ageOf(profile: Profile, now = Date.now()): string {
  const ms = Math.max(0, now - profile.recordedAt)
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  return `${Math.round(hours / 24)} days ago`
}

/** The recording as `weft profile` prints it: what was seen, what it decided, what it refused to. */
export function formatProfile(profile: Profile, decisions: Decisions): string {
  const lines: string[] = [
    '',
    `  recorded ${ageOf(profile)}, over ${Math.round(profile.forMs / 1000)}s of traffic`,
    '',
  ]

  for (const route of decisions.routes) {
    const observed = profile.routes[route.route]
    lines.push(`  ${route.route}   ${observed?.requests ?? 0} request(s)`)
    if (!route.slots.length) lines.push('    nothing decided: no slot has enough renders yet')
    for (const decision of route.slots) {
      const label = decision.delivery === 'stream' ? `stream prio ${decision.prio ?? 0}` : 'buffered'
      const hits = observed?.slots[decision.slot]?.hits ?? 0
      lines.push(
        `    ${decision.slot.padEnd(12)} ${label.padEnd(16)} ${decision.because}${hits ? `, and ${hits} hit(s)` : ''}`,
      )
    }
    if (route.stage.length) {
      lines.push(`    readers arrive from ${route.stage.join(', ')} often enough to stage this route`)
    }
    lines.push('')
  }

  if (decisions.discover.length) {
    lines.push('  what is worth describing before anybody looks at it')
    for (const decision of decisions.discover) {
      lines.push(
        `    ${decision.route.padEnd(26)} ${decision.describe ? 'describe' : 'skip    '} ${decision.because}`,
      )
    }
    lines.push('')
  }

  if (decisions.thin.length) {
    lines.push(
      `  too few renders to decide (fewer than ${MIN_SAMPLES}): ` +
        decisions.thin
          .map((t) => {
            const hits = profile.routes[t.route]?.slots[t.slot]?.hits ?? 0
            return `${t.route}:${t.slot} (${t.renders} render${t.renders === 1 ? '' : 's'}${hits ? `, ${hits} hits` : ''})`
          })
          .join(', '),
      '',
      '  A slot that is nearly always a hit is a slot whose delivery barely matters, so having',
      '  nothing to say about it is the right answer rather than a gap in the recording.',
      '',
    )
  }

  lines.push('  what a profile does not decide here')
  for (const refusal of decisions.refused) lines.push(`    ${refusal.what} — ${refusal.why}`)
  lines.push('')
  return lines.join('\n')
}
