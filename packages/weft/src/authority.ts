import {
  covers,
  createEnvelope,
  createReads,
  envelopeContext,
  lifecycle,
  requestFacts,
  createCapabilityModel,
  createIntentSigner,
  createIntentVerifier,
  roleGrants,
  type CapabilityModel,
  type Grant,
  type IntentSigner,
  type IntentVerifier,
  type Ports,
  type StorePort,
} from '@weftjs/kernel'
import type { IntentManifest } from './intents.ts'

/**
 * What a deployment binds when its intents declare authority, resolved once.
 *
 * Three things the kernel names as seams and one thing only the front door can do. The capability
 * model and the verifier are wired into both intent bindings — the POST path and the channel — so a
 * grant cannot be enforced on one and not the other. The signer is the third, and it is optional on
 * purpose: a tier that holds public keys and no private key can check every token and mint none,
 * which is the design's separable authority tier expressed as a config file.
 *
 * The fourth is the closed-set check. Only the front door has both halves — the intent manifest
 * knows every capability any intent declares, and the config knows what a role table can ever
 * grant — so it is the only place that can catch a capability nothing can grant. That is an intent
 * which is permanently 403 with nothing saying why, and it is the failure a typo in either half
 * actually produces.
 */
export interface AuthorityConfig {
  /**
   * What each role holds. `cart:*` covers every capability under `cart:`; a bare `*` is refused,
   * because a grant that matches everything makes declaring a capability decorative.
   */
  grants?: Record<string, readonly Grant[]>
  /**
   * Which roles a subject has. Without one, a caller with a session is `user` and a caller without
   * is `anonymous` — the smallest model that is a real one, and enough to say "signed in may write".
   */
  roles?(subject: string): Promise<readonly string[]> | readonly string[]
  /** Capabilities every caller holds, session or not. Where a deliberately public one goes. */
  ambient?: readonly Grant[]
  /** The role of a caller with no session. Defaults to `anonymous`. */
  anonymous?: string
  /**
   * Ed25519 keys, for the intents that declare `signed`.
   *
   * Keys are base64 of the standard encodings — PKCS#8 for the private key, SPKI for a public one —
   * or already-imported `CryptoKey`s for a deployment that gets them from a KMS. `publicKeys` is a
   * bundle by key id so rotation is a key added rather than a deploy of both tiers at once.
   */
  signing?: {
    kid: string
    privateKey?: string | CryptoKey
    publicKeys?: Record<string, string | CryptoKey>
    ttlMs?: number
  }
  /** Every decision, allowed and denied. A log of denials only is one an escalation is silent in. */
  audit?(decision: {
    allowed: boolean
    subject: string | null
    required: readonly string[]
    missing: readonly string[]
  }): void
}

/** What this deployment bound of the authority tier: the checks, the signer, the verifier. */
export interface Authority {
  model: CapabilityModel | null
  signer: IntentSigner | null
  verifier: IntentVerifier | null
  /** Every capability any intent declares, which is the closed set the grants are checked against. */
  declared: string[]
  /** Intent ids that require a signature, for the page prelude. */
  signed: string[]
  diagnostics: string[]
}

/** A configuration refusal: a key that will not load, or a grant naming nothing. */
export class AuthorityConfigError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = 'AuthorityConfigError'
    this.code = code
  }
}

function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
  const clean = text.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  const raw = atob(clean.replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

async function importKey(
  value: string | CryptoKey,
  kind: 'pkcs8' | 'spki',
  usage: 'sign' | 'verify',
): Promise<CryptoKey> {
  if (typeof value !== 'string') return value
  try {
    return await crypto.subtle.importKey(kind, decodeBase64(value), { name: 'Ed25519' }, false, [usage])
  } catch (error) {
    throw new AuthorityConfigError(
      'E_BAD_SIGNING_KEY',
      `the ${kind} key could not be imported as Ed25519: ${error instanceof Error ? error.message : String(error)}. ` +
        `A runtime whose WebCrypto has no Ed25519 cannot ${usage} a weft intent token, and refusing here is the honest place to find out`,
    )
  }
}

/** An Ed25519 pair, base64'd the way the config wants them. For a deployment with no key yet. */
export async function generateSigningKeys(): Promise<{ privateKey: string; publicKey: string }> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const priv = await crypto.subtle.exportKey('pkcs8', pair.privateKey)
  const pub = await crypto.subtle.exportKey('spki', pair.publicKey)
  return { privateKey: base64(priv), publicKey: base64(pub) }
}

function base64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let ascii = ''
  for (const byte of bytes) ascii += String.fromCharCode(byte)
  return btoa(ascii)
}

/** Turn the config's authority block into the ports, refusing a half-configured one by name. */
export async function resolveAuthority(
  config: AuthorityConfig | undefined,
  intents: IntentManifest,
  store: StorePort,
  ports: Ports,
): Promise<Authority> {
  const diagnostics: string[] = []
  const declared = [...new Set(intents.entries.flatMap((entry) => entry.capabilities))]
  const signed = intents.entries.filter((entry) => entry.signed).map((entry) => entry.id)

  /**
   * A limit nothing counts, said at startup.
   *
   * Outside the `config` branch below because rate limiting is not part of `authority` in the config
   * — it is a port, since what a call is counted against is a deployment's decision and not a role
   * table. What it shares with the other two is the failure mode: a declaration nothing enforces,
   * refused at request time with a 501, which is correct and is the wrong moment to find out.
   */
  const limited = intents.entries.filter((entry) => entry.limit)
  if (limited.length && !ports.limits) {
    diagnostics.push(
      `W_NO_RATE_LIMIT: ${limited.map((entry) => entry.name).join(', ')} declare a limit and no limits ` +
        `port is bound, so every call is E_NO_RATE_LIMIT. Bind weft.config.ts's \`limits\` — ` +
        `countingLimits({ store, counted }) in @weftjs/adapters, where \`counted\` is the decision a ` +
        `kernel cannot make for you`,
    )
  }

  if (!config) {
    /**
     * Nothing bound, and the dispatch already refuses what declares authority — with a 501 at
     * request time, which is correct and is the wrong moment to find out. So it is said here too,
     * where somebody starting the server can read it.
     */
    if (declared.length) {
      diagnostics.push(
        `W_NO_CAPABILITY_MODEL: ${declared.join(', ')} ${declared.length === 1 ? 'is' : 'are'} declared by an intent and nothing grants ${declared.length === 1 ? 'it' : 'them'}. ` +
          `Every call is E_NO_CAPABILITY_CHECK until weft.config.ts binds authority.grants`,
      )
    }
    if (signed.length) {
      diagnostics.push(
        `W_NO_VERIFIER: ${signed.length} intent(s) require a signature and no keys are bound, so every call is E_NO_VERIFIER`,
      )
    }
    return { model: null, signer: null, verifier: null, declared, signed, diagnostics }
  }

  const table = config.grants ?? {}
  const ambient = config.ambient ?? []

  /**
   * A capability nothing can grant is an intent nobody can ever run.
   *
   * A build error rather than a warning, because the failure it prevents is a 403 in production for
   * a reason that is invisible in the code: the intent looks gated, the role table looks populated,
   * and the two do not meet. The reverse — a grant naming a capability no intent declares — is a
   * stale row rather than a broken page, so it is said and not refused.
   */
  // `covers` rather than a second spelling of the rule: the check has to agree with the model
  // exactly, and two implementations of "does this grant cover this capability" would eventually not.
  const grantable = [...ambient, ...Object.values(table).flat()]
  const ungrantable = declared.filter((capability) => !grantable.some((grant) => covers(grant, capability)))
  if (ungrantable.length) {
    throw new AuthorityConfigError(
      'E_CAPABILITY_UNGRANTABLE',
      `${ungrantable.join(', ')} ${ungrantable.length === 1 ? 'is' : 'are'} required by an intent and granted by no role in weft.config.ts. ` +
        `Add ${ungrantable.length === 1 ? 'it' : 'them'} to a role, or stop declaring ${ungrantable.length === 1 ? 'it' : 'them'}`,
    )
  }
  const unused = grantable.filter((grant) => !declared.some((capability) => covers(grant, capability)))
  if (unused.length) {
    diagnostics.push(
      `W_GRANT_UNUSED: ${[...new Set(unused)].join(', ')} ${unused.length === 1 ? 'is' : 'are'} granted and no intent declares ${unused.length === 1 ? 'it' : 'them'}`,
    )
  }

  const model = createCapabilityModel({
    grants: roleGrants({
      table,
      // One role for "has a session" is the smallest model that says anything, and it is a row an
      // operator can see rather than a branch in the framework.
      roles: config.roles ?? ((): string[] => ['user']),
      ...(config.anonymous ? { anonymous: config.anonymous } : {}),
    }),
    ambient,
    ...(config.audit ? { audit: config.audit } : {}),
    ...(ports.telemetry ? { telemetry: ports.telemetry } : {}),
  })

  let signer: IntentSigner | null = null
  let verifier: IntentVerifier | null = null
  if (config.signing) {
    const publicKeys: Record<string, CryptoKey> = {}
    for (const [kid, value] of Object.entries(config.signing.publicKeys ?? {})) {
      publicKeys[kid] = await importKey(value, 'spki', 'verify')
    }
    if (config.signing.privateKey) {
      signer = createIntentSigner({
        kid: config.signing.kid,
        key: await importKey(config.signing.privateKey, 'pkcs8', 'sign'),
        ...(config.signing.ttlMs ? { ttlMs: config.signing.ttlMs } : {}),
      })
    }
    if (Object.keys(publicKeys).length) {
      verifier = createIntentVerifier({ keys: publicKeys, store })
      /**
       * What the replay window actually covers, said out loud.
       *
       * A nonce is spent by taking a lease nobody releases, so a process-local store protects one
       * process. On one machine that is the whole deployment and this is noise; behind a load
       * balancer it is the difference between single-use and single-use-per-instance, and a
       * deployment that has not been told will assume the stronger reading.
       */
      if (verifier.replayScope === 'process') {
        diagnostics.push(
          `W_REPLAY_PROCESS_LOCAL: a spent nonce is remembered in '${store.name}', whose leases are ` +
            `process-scoped, so a signed intent is single-use per process rather than per deployment. ` +
            `sharedLeases(store, { dir }) makes it per machine and redisLeases(store, { url }) makes ` +
            `it per deployment, both in @weftjs/adapters`,
        )
      }
    } else if (signer) {
      diagnostics.push(
        'W_NO_PUBLIC_KEYS: authority.signing has a private key and no public keys, so this process can mint tokens it cannot check',
      )
    }
  }
  if (signed.length && !verifier) {
    diagnostics.push(
      `W_NO_VERIFIER: ${signed.length} intent(s) require a signature and no public key is bound, so every call is E_NO_VERIFIER`,
    )
  }
  if (signed.length && !signer) {
    diagnostics.push(
      'W_NO_SIGNER: an intent requires a signature and this process cannot mint one, so /_weft/token refuses by name',
    )
  }

  return { model, signer, verifier, declared, signed, diagnostics }
}

/** Where a client asks for a token. Its own path, because minting is not dispatching. */
export const TOKEN_PATH = '/_weft/token'

/** What a page asks for when it needs a signed intent minted for one reader. */
export interface TokenRequest {
  request: Request
  authority: Authority
  intents: IntentManifest
  ports: Ports
}

/**
 * A token, minted for one reader and one call — and the reason it is a request rather than markup.
 *
 * The obvious place for a token is the page: render it into the form, and a mutation with no
 * JavaScript keeps working. It cannot go there. A cache key in this framework is derived from what
 * the compiler saw a fragment read, and a token is not a read — so a region carrying one would be
 * stored under a key that does not describe it and handed to the next reader, whose click would
 * then fail as somebody else's token. The mechanism that makes keys trustworthy is the same
 * mechanism that makes a token in a render unsafe.
 *
 * So minting is its own uncacheable path, which is also where the design puts it: the authority
 * tier "validates render intents, checks capabilities, verifies signatures", separable from the
 * thing that renders pages. Two consequences, both stated rather than discovered:
 *
 * - **A signed intent needs JavaScript.** A form can still post to it and will be refused with
 *   `E_INTENT_UNSIGNED`. Every other intent keeps its no-JavaScript path exactly as it was; this is
 *   the cost of the strongest gate, paid only by the intents that ask for it.
 * - **Minting runs the capability check.** A caller who may not run the intent cannot get a token
 *   for it, so the 403 arrives before the interaction rather than after it.
 */
export async function serveToken(options: TokenRequest): Promise<Response> {
  const { authority, intents, ports } = options
  let asked: { intent?: string; payload?: unknown } = {}
  try {
    const text = await options.request.text()
    if (text) asked = JSON.parse(text) as typeof asked
  } catch {
    return json(400, { code: 'E_TOKEN_REQUEST', detail: 'the body has to be JSON' })
  }
  const named = asked.intent ?? ''
  const id = intents.names[named] ?? named
  const entry = intents.entries.find((candidate) => candidate.id === id)
  if (!entry) return json(404, { code: 'E_NO_SUCH_INTENT', detail: named })
  if (!entry.signed) {
    // Named rather than minted. A token for an intent that does not require one reads like a gate
    // and is not one, which is the failure mode this whole file exists to avoid.
    return json(400, { code: 'E_INTENT_NOT_SIGNED', detail: `${entry.name} requires no token` })
  }
  if (!authority.signer) {
    return json(501, {
      code: 'E_NO_SIGNER',
      detail: 'this process holds no private key, so it can check tokens and mint none',
    })
  }

  const life = lifecycle()
  const envelope = createEnvelope(life)
  life.to('envelope')
  const ctx = envelopeContext(createReads(requestFacts(options.request), ports), envelope)

  if (entry.capabilities.length) {
    if (!authority.model) {
      return json(501, { code: 'E_NO_CAPABILITY_CHECK', detail: entry.capabilities.join(',') })
    }
    const decision = await authority.model.decide(ctx, entry.capabilities)
    if (!decision.allowed) {
      return json(403, { code: 'E_CAPABILITY_DENIED', detail: decision.missing.join(',') })
    }
  }

  const subject = await ctx.user()
  const token = await authority.signer.mint({
    intent: entry.id,
    subject,
    // Bound when the caller says what it is about to send, and only then. An unbound token is
    // weaker and it is the caller's choice to make: it authorises the intent for the window
    // rather than the one call.
    ...(asked.payload === undefined ? {} : { payload: asked.payload }),
  })
  return json(
    200,
    { token, expiresInMs: authority.signer.ttlMs, bound: asked.payload !== undefined },
    { 'cache-control': 'no-store' },
  )
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  })
}
