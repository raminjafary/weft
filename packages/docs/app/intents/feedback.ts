import { defineIntent } from 'weft'

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
  // The complete set of tags this may invalidate. Empty, and empty is a claim: nothing on this
  // site is cached on the strength of a vote, so `ctx.revalidate` from here would be
  // `E_UNDECLARED_WRITE` naming the tag and the field to add it to.
  writes: [],
  input: (raw) => {
    const body = raw as { page?: unknown }
    const page = String(body.page ?? '')
    if (!/^[a-z0-9-]{1,40}$/.test(page)) throw new Error('page must be a guide slug')
    return { page }
  },
  run(_ctx, input) {
    tally.set(input.page, votes(input.page) + 1)
  },
})
