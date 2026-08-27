import type { ChannelHub, RegionBinding } from '@weftjs/kernel'
import type { GeneratedRoute } from './routes.ts'

/**
 * Invalidation, crossing a tier boundary.
 *
 * The composition spec called this a silence and gave the reason: a composite holds a *contract* and
 * a region holds its own keys, so a `STALE` about them has nobody to tell. That reason is about
 * keys, and it is still true — nothing is dropped from any store here, because this deployment has
 * none of the region's entries to drop. What was missing is the other half: which of this
 * composite's open connections are showing that region, which is a question only this side can
 * answer, and telling them is exactly what a local `STALE` does.
 *
 * Three rules, and each is the same rule composition applies everywhere else.
 *
 * **A caller names a region, never a slot.** A slot is a hole in a page the region cannot see, and
 * letting it name one would be the escape the `REGION` frame check exists to prevent. This side maps
 * the region to the slots it fills, which is knowledge only this side has.
 *
 * **Deny by default and deny by name.** A region with no `staleSecret` in `weft.config.ts` cannot
 * tell this composite anything: `E_NO_STALE_SECRET`. A framework that accepted an unauthenticated
 * invalidation would be offering every reader's page to anybody who could reach the endpoint.
 *
 * **Nothing is dropped, and the client decides.** A region going stale is news, not an instruction.
 * The connection is told and asks when it wants to, which is the contract a `STALE` has always had.
 */
export const STALE_PATH = '/_weft/stale'

export interface StaleOptions {
  routes: readonly GeneratedRoute[]
  hub: ChannelHub
  regions: readonly RegionBinding[]
}

interface Asked {
  region?: unknown
  reason?: unknown
}

function refused(code: string, detail: string, status: number): Response {
  return new Response(JSON.stringify({ code, detail }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Constant-time enough for a shared secret, and honest about why.
 *
 * A timing side channel on a comparison that is reached over a network, once per invalidation, by a
 * caller who has to guess a whole secret to learn anything, is not the attack anybody runs. The
 * comparison is written this way because writing it the other way invites the question, and the
 * cost is one loop over a string.
 */
function matches(given: string, expected: string): boolean {
  if (given.length !== expected.length) return false
  let same = 0
  for (let i = 0; i < given.length; i++) same |= given.charCodeAt(i) ^ expected.charCodeAt(i)
  return same === 0
}

export async function serveStale(request: Request, options: StaleOptions): Promise<Response> {
  let asked: Asked
  try {
    asked = (await request.json()) as Asked
  } catch {
    return refused('E_STALE_BODY', 'expected a JSON body of { region, reason }', 400)
  }
  const region = typeof asked.region === 'string' ? asked.region : ''
  if (!region) {
    return refused(
      'E_STALE_REGION',
      'name the region, not a slot: a slot is a hole in a page the region cannot see',
      400,
    )
  }

  const binding = options.regions.find((candidate) => candidate.region === region)
  if (!binding) {
    return refused('E_NO_SUCH_REGION', `nothing in this deployment composes '${region}'`, 404)
  }
  if (!binding.staleSecret) {
    return refused(
      'E_NO_STALE_SECRET',
      `'${region}' has no staleSecret in weft.config.ts, so nothing may tell this deployment that it is stale`,
      403,
    )
  }
  const presented = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!presented || !matches(presented, binding.staleSecret)) {
    return refused('E_STALE_UNAUTHORISED', `the secret presented for '${region}' is not the one bound`, 403)
  }

  /**
   * Which slots that region fills, across every route that composes it.
   *
   * A region is bound by name and spliced into a hole per route, and the two names are usually the
   * same and are not required to be. Reading the routes rather than assuming the slot name is what
   * makes a page that composes `search` into a hole called `results` work.
   */
  const slots = new Set<string>()
  for (const route of options.routes) {
    for (const [slot, spec] of Object.entries(route.remote)) {
      if (spec.region === region) slots.add(slot)
    }
  }
  if (!slots.size) {
    return refused(
      'E_NO_SUCH_REGION',
      `'${region}' is bound but no route composes it, so no connection can be showing it`,
      404,
    )
  }

  const reason = typeof asked.reason === 'string' && asked.reason ? asked.reason : `region:${region}`
  const told = await options.hub.notifySlots([...slots], reason)
  return new Response(JSON.stringify({ region, slots: [...slots], told }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
