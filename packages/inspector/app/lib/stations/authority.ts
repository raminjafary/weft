import { memoryStore, cookieSession, staticFlags } from '@weftjs/adapters'
import {
  createCapabilityModel,
  createEnvelope,
  createExtender,
  createIntentSigner,
  createIntentVerifier,
  createReads,
  envelopeContext,
  lifecycle,
  requestFacts,
  roleGrants,
  type DiscoveredRoute,
  type EnvelopeContext,
  type Ports,
} from '@weftjs/kernel'
import { escapeHtml, field, panel, pick, pre, press, readout } from '../pages.ts'
import type { StationHandler } from './kind.ts'

/**
 * The authority stations: who may run an intent, and whether this deployment issued the call.
 *
 * Both pages run the real model and the real verifier over a real Ed25519 key generated when the
 * page renders. Nothing here is a table of what would happen — every row is a decision that was
 * actually taken while the page was being served, which is the only version worth showing for a
 * mechanism whose entire job is to say no.
 */
const ports = (): Ports => ({
  store: memoryStore(),
  session: cookieSession({ cookie: 'sid' }),
  flags: staticFlags({ axes: {} }),
  executors: {},
})

/** A caller, as the dispatch would see one: an envelope context with a session cookie or without. */
function caller(subject: string | null, bound: Ports): EnvelopeContext {
  const life = lifecycle()
  const envelope = createEnvelope(life)
  life.to('envelope')
  const headers = new Headers()
  if (subject) headers.set('cookie', `sid=${subject}`)
  const request = new Request('https://inspector.test/checkout', { headers })
  return envelopeContext(createReads(requestFacts(request), bound), envelope)
}

const TABLE: Record<string, string[]> = {
  anonymous: ['catalogue:read'],
  customer: ['cart:write', 'cart:read'],
  staff: ['cart:*', 'order:refund'],
}

const ROLES = ['anonymous', 'customer', 'staff']
const ASKS = ['cart:write', 'cart:line:delete', 'order:refund', 'cart:write,order:refund', 'billing:void']

export const capabilities: StationHandler = async (ctx) => {
  const role = ctx.query('role') ?? 'customer'
  const asked = (ctx.query('needs') ?? 'cart:write').split(',').filter(Boolean)
  const bound = ports()
  const model = createCapabilityModel({
    grants: roleGrants({ table: TABLE, roles: () => (role === 'anonymous' ? [] : [role]) }),
    ambient: ['catalogue:read'],
  })

  // Both callers, every time: the interesting part of a gate is the pair of answers, not one of them.
  const signedIn = await model.decide(caller('u42', bound), asked)
  const anonymous = await model.decide(caller(null, bound), asked)

  return {
    panel: panel(
      [
        field('role', pick('authority-role', ROLES, role)),
        field('the intent requires', pick('authority-needs', ASKS, asked.join(','))),
        press('authority-go', 'decide'),
      ].join(''),
      'The role table is on this page and the grants are real. `cart:*` covers everything under that colon and nothing above it, so ask for cart:line:delete as staff and then as a customer.',
    ),
    body: async () =>
      readout(
        `${asked.join(' + ')} — decided twice`,
        [
          {
            label: `a reader with a session, role ${escapeHtml(role)}`,
            value: signedIn.allowed ? 'allowed' : 'denied',
            note: signedIn.allowed
              ? `holds ${signedIn.held.join(', ')}`
              : `missing ${signedIn.missing.join(', ')} — holds ${signedIn.held.join(', ') || 'nothing'}`,
            state: signedIn.allowed ? 'within' : 'over',
          },
          {
            label: 'a reader with no session',
            value: anonymous.allowed ? 'allowed' : 'denied',
            note: anonymous.allowed
              ? `holds ${anonymous.held.join(', ')}`
              : `missing ${anonymous.missing.join(', ')} — the anonymous role plus the ambient set`,
            state: anonymous.allowed ? 'within' : 'over',
          },
          {
            label: 'every capability, not any of them',
            value: asked.length > 1 ? `${asked.length} required` : 'one required',
            note:
              asked.length > 1
                ? 'a caller has to hold both. Read the other way, a longer declaration would be a weaker one'
                : 'ask for two at once to see the rule that matters',
          },
          {
            label: 'audited',
            value: `${model.recent().length} decisions`,
            note: 'allows and denials both — a log of denials only is one a successful escalation is silent in',
          },
        ],
        {
          what: `Two callers put through the real capability model, with the role table printed above. A denial names what was missing rather than saying no, because a 403 nobody can explain is a 403 somebody works around.`,
          from: 'createCapabilityModel + roleGrants in @weftjs/kernel — the same functions the intent dispatch is given',
          caveat:
            'The grants here come from a table on this page. A deployment resolves roles from whatever it knows about a subject; nothing else changes.',
          tryThis:
            'Ask for billing:void as staff. Nothing grants it, which in a real application is the build error E_CAPABILITY_UNGRANTABLE rather than this denial.',
        },
      ),
  }
}

const FAILURES = [
  'none',
  'replayed',
  'another payload',
  'another intent',
  'another reader',
  'another key',
] as const

export const signedIntents: StationHandler = async (ctx) => {
  const induce = (ctx.query('failure') ?? 'none') as (typeof FAILURES)[number]
  const store = memoryStore()
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const other = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair

  const signer = createIntentSigner({ kid: 'k1', key: pair.privateKey })
  const impostor = createIntentSigner({ kid: 'k1', key: other.privateKey })
  const verifier = createIntentVerifier({ keys: { k1: pair.publicKey }, store })

  const payload = { sku: 'OIL-2L', qty: 2 }
  const minted = await (induce === 'another key' ? impostor : signer).mint({
    intent: induce === 'another intent' ? 'ffffff' : '479a0c',
    subject: induce === 'another reader' ? 'u99' : 'u42',
    payload,
  })

  const presented = { id: '479a0c', subject: 'u42' as string | null }
  const raw = induce === 'another payload' ? { sku: 'OIL-2L', qty: 200 } : payload

  // Spent first when a replay is what the page is demonstrating, because that is what a replay is.
  if (induce === 'replayed') await verifier.verify({ ...presented, token: minted, raw })
  const outcome = await verifier.verify({ ...presented, token: minted, raw })

  const claims = JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob((minted.split('.')[1] as string).replace(/-/g, '+').replace(/_/g, '/')), (c) =>
        c.charCodeAt(0),
      ),
    ),
  ) as Record<string, unknown>

  return {
    panel: panel(
      [field('induce', pick('signed-failure', [...FAILURES], induce)), press('signed-go', 'verify')].join(''),
      'A real Ed25519 pair is generated when this page renders, a token is minted from it, and the verifier checks it. Every failure here is produced rather than described.',
    ),
    body: async () =>
      (await readout(
        `${minted.length} bytes on the wire`,
        [
          {
            label: 'verified',
            value: outcome.ok ? 'accepted' : (outcome.code as string),
            note: outcome.ok ? `bound to the payload: ${String(outcome.boundPayload)}` : outcome.detail,
            state: outcome.ok ? 'within' : 'over',
          },
          {
            label: 'the nonce',
            value: induce === 'replayed' ? 'spent, then presented again' : 'fresh',
            note: 'a lease nobody releases, for the token’s remaining lifetime. The lease is the record',
          },
          {
            label: 'replay window',
            value: verifier.replayScope,
            note:
              verifier.replayScope === 'process'
                ? 'this store is process-scoped, so single-use means single-use per process. A deployment behind a load balancer needs a shared store'
                : 'shared, so a nonce is spent everywhere at once',
            state: verifier.replayScope === 'process' ? 'plain' : 'within',
          },
          {
            label: 'checked in order',
            value: 'signature, claims, nonce',
            note: 'a claim compared before the signature would tell a forger which field to change next',
          },
        ],
        {
          what: `A token minted and checked, live. The claims below are the ones the signature covers: the intent, the reader, a digest of the payload, an expiry and a nonce — so a valid token for one call is not a valid token for another.`,
          from: 'createIntentSigner + createIntentVerifier in @weftjs/kernel, over WebCrypto Ed25519',
          caveat:
            'The key is generated per render, so a token from one load of this page cannot be checked by the next. A deployment holds its keys and rotates them by adding one to the bundle.',
          tryThis:
            'Induce "another payload". The signature is valid, the reader is right, and it is still refused — which is the difference between a capability and a signature.',
        },
      )) + pre(JSON.stringify(claims, null, 2)),
  }
}

const PREFIXES = ['/s/*', '/s/authority', '/', '/nowhere/*']

export const discovery: StationHandler = async (ctx) => {
  const prefix = ctx.query('prefix') ?? '/s/*'
  const max = Math.min(64, Math.max(1, Number(ctx.query('max') ?? 8)))

  /**
   * A route table that is this page's own, described rather than rendered.
   *
   * The inspector's stations are its routes, so the subtree asked about below is real. What the
   * extender returns is what a client would otherwise have to fetch a document to learn — and none
   * of it runs a loader, which is the whole difference between describing a route and staging one.
   */
  const catalogue: DiscoveredRoute[] = [
    { pattern: '/', shell: 'sh-index', shared: false, slots: ['body'], css: '/_weft/s/index.css' },
    { pattern: '/s/authority', shell: 'sh-station', shared: true, slots: ['panel', 'body', 'readout'] },
    { pattern: '/s/signed-intents', shell: 'sh-station', shared: true, slots: ['panel', 'body', 'readout'] },
    { pattern: '/s/discovery', shell: 'sh-station', shared: true, slots: ['panel', 'body', 'readout'] },
    { pattern: '/s/streaming', shell: 'sh-station', shared: true, slots: ['panel', 'body', 'readout'] },
    { pattern: '/s/waves', shell: 'sh-station', shared: true, slots: ['panel', 'body', 'readout'] },
  ]

  const extender = createExtender({
    max,
    resolve: ({ prefix: asked }) => {
      const under = (asked ?? '/').replace(/\/?\*$/, '')
      const found = catalogue.filter((route) => route.pattern.startsWith(under))
      return found.length ? { prefix: asked ?? '/', routes: found } : null
    },
  })
  const frames = await extender.warm({
    value: prefix,
    frame: { kind: 'WARM', header: { plan: prefix } },
    channel: undefined as never,
  })
  const plan = frames[0]
  const body = plan?.body ? new TextDecoder().decode(plan.body) : '[]'
  const described = JSON.parse(body) as DiscoveredRoute[]
  const complete = String(plan?.header['complete']) !== 'false'

  return {
    panel: panel(
      [
        field('prefix', pick('discovery-prefix', PREFIXES, prefix)),
        field('routes per frame', pick('discovery-max', ['1', '2', '8', '64'], String(max))),
        press('discovery-go', 'extend'),
      ].join(''),
      'The prefix is asked about the way a client asks: WARM plan=<prefix>. Lower the cap to see a truncated answer say so, which is the one thing a silent cap gets wrong.',
    ),
    body: async () =>
      (await readout(
        `${described.length} route(s), ${body.length} bytes of frame body`,
        [
          {
            label: 'answered',
            value: described.length ? `${described.length} described` : 'nothing here',
            note: described.length
              ? 'no loader ran. Describing a route is not staging one, which is why a page can know about thirty and stage two'
              : 'an empty PLAN rather than a silence: a client that hears nothing cannot tell that from a frame in flight',
            state: described.length ? 'within' : 'plain',
          },
          {
            label: 'complete',
            value: String(complete),
            note: complete
              ? 'the whole subtree'
              : 'truncated, and it says so — a silent cap reads to the client as “that is all of it”',
            state: complete ? 'within' : 'over',
          },
          {
            label: 'shares this shell',
            value: `${described.filter((route) => route.shared).length} of ${described.length}`,
            note: 'the answer that pays for the frame: a route in another document cannot arrive as regions, and learning that by asking costs a round trip and a render',
          },
          {
            label: 'the frame that carries it',
            value: 'PLAN 0x1e',
            note: 'one arrives unasked when a channel opens, carrying this page and where the profile says its readers go next',
          },
        ],
        {
          what: `A subtree of the plan, extended the way a client extends it. Each record is something that would otherwise cost a document fetch: the shell a route renders into, its region names, its stylesheet, the templates those regions need, and the routes readers go to next.`,
          from: 'createExtender in @weftjs/kernel — the same function the front door gives the channel hub',
          caveat:
            'The catalogue here is written on this page so the prefixes are stable. In an application it is the generated route table, and `shared` is computed against the page the connection is actually on.',
          tryThis:
            'Ask about /nowhere/*. An empty answer is still an answer, and it is what stops a client asking again.',
        },
      )) + pre(body),
  }
}
