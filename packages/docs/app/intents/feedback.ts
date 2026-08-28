import { defineIntent } from '@weftjs/core'

/**
 * The one thing on this site that writes, so the intents page has something real to point at.
 *
 * A render cannot write — that is enforced by the type of the context a render receives — so "was
 * this page useful" cannot be a handler on a page. It is an intent, in `app/intents/`, and the
 * manifest is generated from this directory. `weft why` prints the id this module and export hash
 * to; the page shows the same six characters, computed the same way.
 *
 * The tally lives in this process's memory and nothing pretends otherwise: a real deployment binds
 * a store port, and the page says so beside the form. What is worth demonstrating here is the shape
 * — a declared write set, a validated payload, and a POST that works with JavaScript switched off —
 * rather than a database this site has no reason to have.
 */
const tally = new Map<string, number>()

/** What the counters hold right now, for the page that renders them. */
export function votes(page: string): number {
  return tally.get(page) ?? 0
}

export const helpful = defineIntent<{ page: string }>({
  name: 'docs.helpful',
  /**
   * The complete set of tags this may invalidate, and it is a set rather than empty now.
   *
   * It was empty, with a note explaining that the number on the page therefore never moved: the
   * route is built to a file, so the count it rendered was whatever it had been at build time and
   * pressing the button changed a counter nobody could see. That is a correct description of a
   * page demonstrating intents, and a poor demonstration — the example on the intents page could
   * not show the one thing the page is about.
   *
   * Declaring the tag is what connects the write to the region. `revalidate` may only name a tag
   * that appears here, so this list is the thing that makes the line below legal.
   */
  writes: ['docs.votes'],
  input: (raw) => {
    const body = raw as { page?: unknown }
    const page = String(body.page ?? '')
    if (!/^[a-z0-9-]{1,40}$/.test(page)) throw new Error('page must be a guide slug')
    return { page }
  },
  async run(ctx, input) {
    tally.set(input.page, votes(input.page) + 1)
    // The tally is in memory and the rendered count is in a cache entry: without this they are two
    // different numbers and only the first one moved.
    await ctx.revalidate('docs.votes')
  },
})
