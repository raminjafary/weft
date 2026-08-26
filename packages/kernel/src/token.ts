import type { StorePort } from './ports.ts'

/**
 * Signed intents: the discipline mobile server-driven UI has used for years, on the intent
 * catalogue that already exists.
 *
 * The capability model answers "may this caller do this". A signature answers a different question
 * that no capability check can: **was this call authorised by the server that rendered the page**.
 * A capability is a property of the caller, so a caller who holds `cart:write` may write any cart
 * the payload names; a token binds the intent, the subject, the payload and a deadline, so a
 * high-value flow can be reached only through a page the server actually served.
 *
 * Ed25519 rather than an HMAC, and asymmetric for the reason the design gives it a tier of its
 * own: the verifier holds public keys only. An edge that can check a token cannot mint one, so the
 * thing that has to be small and auditable is the thing that has to be small and auditable, and
 * the signing key stays where the pages are rendered.
 *
 * What it does not do, stated where a reader will meet it:
 *
 * - **A token is not a capability.** Both are checked, in that order, and neither substitutes for
 *   the other. A signature says the server issued this call; a grant says this caller may make it.
 * - **Replay protection is exactly as strong as the store's lease.** A nonce is spent by taking a
 *   lease nobody releases, so a store whose leases are process-scoped gives per-process protection
 *   and says so — `replayScope` reports it rather than leaving a deployment to assume the stronger
 *   reading. It reads the store's `leaseScope`, which is deliberately a different field from `scope`:
 *   how far a lease is agreed and how far an entry may travel are two questions, and a deployment
 *   should not have to make its cache shared in order to make its nonces single-use.
 * - **A token without `p` binds no payload.** It says "this reader may run this intent before this
 *   time", which is weaker than it looks: the quantity can be edited. Minting with the payload is
 *   the one that makes a token a receipt.
 */
export const TOKEN_ALG = 'Ed25519'
export const TOKEN_PREFIX = 'weft1'

export interface IntentClaims {
  /** Key id. Rotation is a key added to the verifier's bundle, never a redeploy of both tiers. */
  kid: string
  /** The intent, by the opaque id the compiler derived. A token for one intent cannot run another. */
  i: string
  /** The subject it was minted for. A token lifted from another reader's page is not this reader's. */
  s?: string
  /** SHA-256 of the canonical payload, when the token binds one. */
  p?: string
  /** Expiry, epoch milliseconds. */
  x: number
  /** Single-use nonce. */
  n: string
  /**
   * Delegation depth. Absent means minted directly, `1` means minted from a token, and a verifier
   * refuses anything past its own ceiling — which defaults to zero, so a deployment that never
   * asked for delegation refuses a delegated token by name rather than by accident.
   */
  d?: number
  /** The nonce of the token this one was minted from. An audit reads the chain backwards. */
  pn?: string
}

export interface MintRequest {
  /** The opaque intent id, as it travels. */
  intent: string
  subject?: string | null
  /**
   * The payload this token authorises. Given, the token is a receipt for one call; omitted, it
   * authorises the intent for the window and the payload is the caller's.
   */
  payload?: unknown
  /** Overrides the signer's default lifetime for one token. */
  ttlMs?: number
}

export interface SignerOptions {
  kid: string
  /** A private Ed25519 key. `usages` must include `sign`; the signer never imports one itself. */
  key: CryptoKey
  /** Default lifetime. Short on purpose: a token is for one interaction, not for a session. */
  ttlMs?: number
  clock?(): number
  nonce?(): string
  /**
   * How deep a delegation chain this signer will mint. One by default: a token may be narrowed
   * once, and the narrowed one is a leaf.
   *
   * A chain is the part of delegation that gets away from people — every link is another place an
   * authorisation could have been narrowed wrongly, and the audit is only as good as somebody's
   * willingness to walk it. One link is a shape a person can hold in their head.
   */
  maxDepth?: number
}

/**
 * A token minted from a token, and the four ways it may only be narrower.
 *
 * Delegation exists for one shape of problem: something that is not the reader has to act on the
 * reader's behalf, once, for less than the reader could. A region on another deployment is the case
 * this framework has — a composite holds an authorisation and the region needs a strictly smaller
 * one to do its part.
 *
 * It happens at the **signing** tier and not by attenuating a signature, which is the decision
 * everything else follows from. Macaroon-style caveats would need the verifier to hold the root
 * secret, and the whole reason this tier is separable is that the verifier holds public keys only.
 * So a delegate is a new signature over smaller claims, and the parent is *spent* producing it —
 * one authorisation in, one out, and no way to fan a token into many.
 */
export interface DelegateRequest {
  /** The token being narrowed. Verified, and its nonce spent, before anything is minted. */
  token: string
  /** Who is asking, from the session. The parent must have been for them, if it named anybody. */
  subject: string | null
  /** The intent the child authorises. Only the parent's own, which is what makes it not wider. */
  intent: string
  /** Bind the child to one payload. Legal when the parent bound none, or bound the same one. */
  payload?: unknown
  /** The child's lifetime. Clamped to what is left of the parent's, never extending it. */
  ttlMs?: number
}

export interface IntentSigner {
  readonly kid: string
  mint(request: MintRequest): Promise<string>
  /**
   * Narrow a token into a shorter-lived, more specific one.
   *
   * Needs a verifier because the parent has to be checked before it is trusted, and checking it is
   * what spends it. Every refusal is named: `E_DELEGATE_WIDER` for a claim that grows,
   * `E_DELEGATE_LONGER` for a window that outlives its parent's, `E_DELEGATE_DEPTH` for a chain
   * past the ceiling.
   */
  delegate(request: DelegateRequest, verifier: IntentVerifier): Promise<string>
  /** The lifetime a minted token gets, so a page can say when what it is showing goes stale. */
  readonly ttlMs: number
  /** How deep a chain this signer will mint. Zero refuses delegation outright. */
  readonly maxDepth: number
}

export class TokenError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(`${code} — ${message}`)
    this.name = 'TokenError'
    this.code = code
  }
}

const DEFAULT_TTL = 5 * 60_000
const utf8 = new TextEncoder()

export function createIntentSigner(options: SignerOptions): IntentSigner {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL
  const clock = options.clock ?? ((): number => Date.now())
  const nonce = options.nonce ?? (() => crypto.randomUUID().replace(/-/g, '').slice(0, 16))

  const maxDepth = options.maxDepth ?? 1

  const issue = async (claims: IntentClaims): Promise<string> => {
    const body = utf8.encode(JSON.stringify(claims))
    const signature = await sign(options.key, body)
    return `${TOKEN_PREFIX}.${b64url(body)}.${b64url(new Uint8Array(signature))}`
  }

  return {
    kid: options.kid,
    ttlMs,
    maxDepth,
    async mint(request) {
      return issue({
        kid: options.kid,
        i: request.intent,
        ...(request.subject ? { s: request.subject } : {}),
        ...(request.payload === undefined ? {} : { p: await digest(request.payload) }),
        x: clock() + (request.ttlMs ?? ttlMs),
        n: nonce(),
      })
    },

    async delegate(request, verifier) {
      if (maxDepth < 1) {
        throw new TokenError('E_DELEGATE_DEPTH', 'this signer does not delegate: maxDepth is zero')
      }
      /**
       * The parent is verified first, which is also what spends it.
       *
       * Verification is not a read: it takes the nonce's lease and never gives it back, so a token
       * can be narrowed once and the parent is dead afterwards. That is the property that keeps
       * delegation from being a fan-out — one authorisation in, one out — and it is why this cannot
       * be done without a verifier however convenient a signature-only version would be.
       */
      const parent = await verifier.verify({
        id: request.intent,
        token: request.token,
        raw: request.payload,
        subject: request.subject,
      })
      if (!parent.ok) throw new TokenError(parent.code, parent.detail)

      const depth = (parent.claims.d ?? 0) + 1
      if (depth > maxDepth) {
        throw new TokenError(
          'E_DELEGATE_DEPTH',
          `this token is already ${parent.claims.d ?? 0} deep and this signer mints ${maxDepth}`,
        )
      }
      /**
       * The payload needs no rule of its own, and that is worth saying rather than adding one.
       *
       * `verify` above was given `request.payload` as the payload presented, so a parent that binds
       * one has already refused a child binding anything else — including a child binding nothing,
       * which is the widening case. The check that would have gone here would never fire, and a
       * guard that cannot fire is a guard nobody can trust.
       */
      const now = clock()
      const asked = now + (request.ttlMs ?? ttlMs)
      if (request.ttlMs !== undefined && asked > parent.claims.x) {
        throw new TokenError(
          'E_DELEGATE_LONGER',
          `the child would outlive its parent by ${Math.round((asked - parent.claims.x) / 1000)}s`,
        )
      }
      return issue({
        kid: options.kid,
        i: request.intent,
        // A parent for nobody in particular may be narrowed to somebody; a parent for somebody
        // stays theirs, which `verify` has already established.
        ...((parent.claims.s ?? request.subject)
          ? { s: (parent.claims.s ?? request.subject) as string }
          : {}),
        ...(request.payload === undefined ? {} : { p: await digest(request.payload) }),
        // Clamped rather than refused when no lifetime was asked for: a delegate that quietly
        // outlived its parent would be the whole point of the mechanism, inverted.
        x: Math.min(asked, parent.claims.x),
        n: nonce(),
        d: depth,
        pn: parent.claims.n,
      })
    },
  }
}

async function sign(key: CryptoKey, body: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
  try {
    return await crypto.subtle.sign({ name: TOKEN_ALG }, key, body)
  } catch (error) {
    throw new TokenError('E_NO_ED25519', unsupported(error) ?? `signing failed: ${reasonOf(error)}`)
  }
}

export interface VerifierOptions {
  /**
   * How deep a delegation chain this verifier accepts. **Zero by default**, which is the same
   * refusal the design had before delegation existed — with a name on it: a deployment that never
   * asked for delegation refuses a delegated token as `E_DELEGATE_DEPTH` rather than accepting one
   * because nobody thought about it.
   */
  maxDepth?: number
  /**
   * The pinned public key bundle, by key id. Pinned means exactly that: an unknown `kid` is
   * refused rather than resolved, because a verifier that would fetch a key named by the token it
   * is checking is a verifier an attacker chooses the key for.
   */
  keys: Record<string, CryptoKey>
  /** Where a spent nonce is recorded. A lease nobody releases is the record. */
  store: StorePort
  clock?(): number
  /** Tolerated clock skew between the tier that minted and the tier that checks. */
  skewMs?: number
}

export interface VerifyRequest {
  /** The intent actually being dispatched. The token has to agree with it. */
  id: string
  token?: string
  /** The payload as it arrived, before `input()`. What a bound token is checked against. */
  raw: unknown
  /** Who is asking, from the session. A token minted for somebody else is not this caller's. */
  subject: string | null
}

export type VerifyOutcome =
  { ok: true; claims: IntentClaims; boundPayload: boolean } | { ok: false; code: string; detail: string }

export interface IntentVerifier {
  verify(request: VerifyRequest): Promise<VerifyOutcome>
  /**
   * How far a spent nonce is remembered: `process` is per isolate, `shared` is everywhere. A
   * deployment reading this is a deployment that knows what its replay protection covers.
   */
  readonly replayScope: 'process' | 'shared'
  readonly kids: readonly string[]
}

const NONCE_PREFIX = 'weft:intent-nonce:'

export function createIntentVerifier(options: VerifierOptions): IntentVerifier {
  const clock = options.clock ?? ((): number => Date.now())
  const skew = options.skewMs ?? 5_000

  return {
    // The lease's scope and not the store's, because a nonce is a lease: a process-local cache that
    // takes shared leases gives per-deployment single-use, and reading `scope` here would have
    // reported the cache's reach instead of the guarantee's.
    replayScope: options.store.leaseScope ?? options.store.scope,
    kids: Object.keys(options.keys),

    async verify(request) {
      if (!request.token) {
        // Not led by the opaque id: this refusal is the one a person reads, on a page the framework
        // renders for a form post, and six hex characters tell them nothing they can act on.
        return refused('E_INTENT_UNSIGNED', 'a signed token is required and none was sent')
      }
      const parts = request.token.split('.')
      if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) {
        return refused('E_INTENT_TOKEN_MALFORMED', `expected ${TOKEN_PREFIX}.<claims>.<signature>`)
      }
      let body: Uint8Array<ArrayBuffer>
      let signature: Uint8Array<ArrayBuffer>
      let claims: IntentClaims
      try {
        body = unb64url(parts[1] as string)
        signature = unb64url(parts[2] as string)
        claims = JSON.parse(new TextDecoder().decode(body)) as IntentClaims
      } catch (error) {
        return refused('E_INTENT_TOKEN_MALFORMED', reasonOf(error))
      }
      if (typeof claims?.kid !== 'string' || typeof claims.i !== 'string' || typeof claims.n !== 'string') {
        return refused('E_INTENT_TOKEN_MALFORMED', 'claims are missing kid, i or n')
      }

      const key = options.keys[claims.kid]
      if (!key) {
        return refused('E_TOKEN_KEY_UNKNOWN', `no pinned public key is named ${claims.kid}`)
      }

      /**
       * The signature first, and every claim after it.
       *
       * Checking the intent id or the subject before the signature would answer questions about
       * claims nobody has authenticated — which tells a caller whose token was rejected exactly
       * which field to change next.
       */
      let valid: boolean
      try {
        valid = await crypto.subtle.verify({ name: TOKEN_ALG }, key, signature, body)
      } catch (error) {
        const missing = unsupported(error)
        if (missing) return refused('E_NO_ED25519', missing)
        return refused('E_INTENT_SIGNATURE', reasonOf(error))
      }
      if (!valid) return refused('E_INTENT_SIGNATURE', `the signature over ${claims.kid} does not verify`)

      const now = clock()
      if (!Number.isFinite(claims.x) || now - skew > claims.x) {
        return refused('E_INTENT_EXPIRED', `expired ${Math.round((now - claims.x) / 1000)}s ago`)
      }
      if (claims.i !== request.id) {
        return refused('E_TOKEN_WRONG_INTENT', `issued for ${claims.i}, presented for ${request.id}`)
      }
      if (claims.s !== undefined && claims.s !== request.subject) {
        return refused('E_TOKEN_WRONG_SUBJECT', 'issued for a different reader')
      }
      if (claims.p !== undefined && claims.p !== (await digest(request.raw))) {
        return refused('E_TOKEN_WRONG_PAYLOAD', 'issued for a different payload')
      }
      const depth = claims.d ?? 0
      if (depth > (options.maxDepth ?? 0)) {
        return refused(
          'E_DELEGATE_DEPTH',
          `this token was delegated ${depth} deep and this deployment accepts ${options.maxDepth ?? 0}`,
        )
      }

      /**
       * Spent last, and only once everything else has passed.
       *
       * The lease is the record: taking it and never releasing it means the nonce is unusable for
       * as long as the token could have been, and no nonce record outlives the token it describes.
       * A store that hands the lease to somebody else is a store saying this token has already
       * been used — which is the answer, not an error.
       */
      const remaining = Math.max(1, claims.x - now + skew)
      let lease: unknown
      try {
        lease = await options.store.lease(`${NONCE_PREFIX}${claims.n}`, remaining)
      } catch (error) {
        // A store that cannot answer cannot say the nonce is fresh, and a signed intent that
        // proceeds on a maybe is a signed intent that can be replayed during an outage.
        return refused('E_REPLAY_UNKNOWN', `the store could not record the nonce: ${reasonOf(error)}`)
      }
      if (!lease) return refused('E_INTENT_REPLAYED', 'this token has already been used')

      return { ok: true, claims, boundPayload: claims.p !== undefined }
    },
  }
}

function refused(code: string, detail: string): VerifyOutcome {
  return { ok: false, code, detail }
}

function unsupported(error: unknown): string | null {
  const name = (error as { name?: string } | null)?.name
  if (name !== 'NotSupportedError' && name !== 'NotSupported') return null
  return `this runtime's WebCrypto does not implement ${TOKEN_ALG}, so a signed intent cannot be checked here`
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The payload, in one spelling.
 *
 * A digest over `JSON.stringify` as it happens to come out would make a token that binds
 * `{a:1,b:2}` refuse `{b:2,a:1}` — the same call, written by a client that iterated its own object
 * in a different order. Keys are sorted at every depth, and arrays are left alone because their
 * order is data.
 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
}

export async function digest(value: unknown): Promise<string> {
  const bytes = utf8.encode(canonical(value))
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return b64url(new Uint8Array(hash))
}

/** Base64url, without `Buffer`: the kernel has the Minimum Common API and nothing else. */
export function b64url(bytes: Uint8Array): string {
  let ascii = ''
  // Chunked, because spreading a large array into `fromCharCode` overflows the argument list.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    ascii += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(ascii).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function unb64url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
  const ascii = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const out = new Uint8Array(ascii.length)
  for (let i = 0; i < ascii.length; i++) out[i] = ascii.charCodeAt(i)
  return out
}
