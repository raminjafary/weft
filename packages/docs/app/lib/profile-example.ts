import { PROFILE_VERSION, type Profile } from '@weftjs/core'

/**
 * A recording, as the framework writes it — typed against the real interface rather than transcribed.
 *
 * The `measuring` page described what a profile records and never showed one, so a reader had to take
 * the shape on trust. Hand-writing the JSON would have put a second source of truth on the page: the
 * fields would drift the first time `RouteObservation` gained one, and nothing would fail.
 *
 * This is `Profile`, so `tsc` checks it. A field renamed in `packages/weft/src/profile.ts` breaks the
 * build here, which is the same bargain every live example on this site makes.
 *
 * The numbers are illustrative and say so on the page. What is not illustrative is the shape, and the
 * shape is the reason to show it: `renders` apart from `hits`, `p95` beside `p50`, `from` as the
 * transition table a staged navigation reads, and `described`/`followed` as the pair that decides
 * whether describing a route ever paid.
 */
export const EXAMPLE_PROFILE: Profile = {
  // The real constant, so a bumped version cannot leave this page describing an older shape.
  version: PROFILE_VERSION,
  recordedAt: 1_756_000_000_000,
  forMs: 1_800_000,
  routes: {
    '/': {
      requests: 4_812,
      slots: {
        panel: { renders: 12, p50: 0.4, p95: 0.9, bytes: 318, hits: 4_800 },
        body: { renders: 4_812, p50: 6.1, p95: 11.4, bytes: 7_344, hits: 0 },
      },
      from: {},
      described: 3_950,
      followed: 2_411,
    },
    '/app/cart': {
      requests: 1_204,
      slots: {
        panel: { renders: 9, p50: 0.3, p95: 0.7, bytes: 318, hits: 1_195 },
        // The one slot a recording would decide to stream: past SLOW_MS, past MIN_STREAM_BYTES,
        // and rarely a hit because it reads identity.
        body: { renders: 1_204, p50: 48.2, p95: 96.7, bytes: 1_582, hits: 0 },
        readout: { renders: 1_204, p50: 1.8, p95: 3.2, bytes: 96, hits: 0 },
      },
      from: { '/': 812, '/app/feed': 331 },
      described: 0,
      followed: 0,
    },
    '/app/feed': {
      requests: 906,
      slots: {
        panel: { renders: 7, p50: 0.3, p95: 0.6, bytes: 318, hits: 899 },
        // Slow, but nearly always a hit: the case a total would have got wrong.
        body: { renders: 41, p50: 62.5, p95: 121.0, bytes: 6_289, hits: 865 },
      },
      from: { '/': 574 },
      described: 1_120,
      followed: 88,
    },
  },
}

/** The bytes the page prints, formatted the way the framework writes the file. */
export function exampleProfileJson(): string {
  return JSON.stringify(EXAMPLE_PROFILE, null, 2)
}
