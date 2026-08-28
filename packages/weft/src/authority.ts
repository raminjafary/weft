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
 * What a deployment binds when its intents declare authority, resolved once: the capability model
 * and verifier wired into both intent bindings, the signer (optional — a tier with no private key
 * can check tokens and mint none), and the closed-set check. See `spec/kernel/authority.md`.
 */
export interface AuthorityConfig {
  /** What each role holds. `cart:*` covers every capability under `cart:`; a bare `*` is refused. */
  grants?: Record<string, readonly Grant[]>
  /** Which roles a subject has. Without one, a caller with a session is `user`, without is `anonymous`. */
  roles?(subject: string): Promise<readonly string[]> | readonly string[]
  /** Capabilities every caller holds, session or not. Where a deliberately public one goes. */
  ambient?: readonly Grant[]
  /** The role of a caller with no session. Defaults to `anonymous`. */
  anonymous?: string
  /**
   * Ed25519 keys, for the intents that declare `signed`. Base64 of PKCS#8 / SPKI, or already-imported
   * `CryptoKey`s. `publicKeys` is a bundle by key id, so rotation is a key added.
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
    // A runtime whose WebCrypto has no Ed25519 cannot sign or verify a weft intent token.
    throw new AuthorityConfigError(
      'E_BAD_SIGNING_KEY',
      `the ${kind} key could not be imported as Ed25519: ${error instanceof Error ? error.message : String(error)}`,
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

  // A limit nothing counts, said at startup. Outside the `config` branch: rate limiting is a port,
  // not part of authority, since what a call is counted against is not a role-table decision.
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
    // Nothing bound. The dispatch already refuses at request time with a 501; said here too,
    // where somebody starting the server can read it.
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

  // A capability nothing can grant is an intent nobody can ever run — a build error, because the
  // failure is a 403 in production invisible in the code. `covers` rather than a second spelling
  // of the rule, so the check cannot drift from the model.
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
      // One role for "has a session" is the smallest model that says anything.
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
      // What the replay window actually covers: a process-local store protects one process, which
      // behind a load balancer is single-use-per-instance rather than single-use. See
      // `spec/kernel/authority.md`.
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
 * A token, minted for one reader and one call — and the reason it is a request rather than markup: a
 * cache key is derived from what the compiler saw a fragment read, and a token is not a read, so a
 * region carrying one would be cached under a key that does not describe it. See `spec/kernel/authority.md`.
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
    // Named rather than minted: a token for an intent that does not require one reads like a gate
    // and is not one.
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
    // Bound only when the caller says what it is about to send. Unbound authorises the intent for
    // the window rather than the one call.
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
