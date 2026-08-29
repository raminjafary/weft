import { defineIntent } from '@weftjs/core'

/**
 * The one thing on this site that writes, so the intents page has something real to point at.
 * The tally lives in this process's memory and nothing pretends otherwise — a real deployment
 * binds a store port. See `spec/kernel/intents.md`.
 */
const tally = new Map<string, number>()

/** What the counters hold right now, for the page that renders them. */
export function votes(page: string): number {
  return tally.get(page) ?? 0
}

export const helpful = defineIntent<{ page: string }>({
  name: 'docs.helpful',
  // This used to be empty, and the count on the page never moved. See `spec/plan/plan.md`.
  writes: ['docs.votes'],
  input: (raw) => {
    const body = raw as { page?: unknown }
    const page = String(body.page ?? '')
    if (!/^[a-z0-9-]{1,40}$/.test(page)) throw new Error('page must be a guide slug')
    return { page }
  },
  async run(ctx, input) {
    tally.set(input.page, votes(input.page) + 1)
    await ctx.revalidate('docs.votes')
  },
})
