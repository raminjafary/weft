import type { EffectSet } from '@weftjs/ir'
import {
  createBinaryDecoder,
  encodeStream,
  frame,
  isUnknown,
  list,
  num,
  str,
  type AnyFrame,
  type Frame,
  type FrameKind,
} from '@weftjs/warp'
import type { Reads } from './context.ts'
import { degrade, inlineExecutor, type ExceedPolicy, type KernelExecutor } from './executor.ts'
import type { Ports, RegionBinding, RegionContract } from './ports.ts'

/**
 * Composition, which is the design's phase 9 and the one thing here that is not a new mechanism.
 *
 * A region is a fragment that happens to live somewhere else. Everything that makes that work
 * already exists: an executor is already a crash domain and a budget boundary, a registry is
 * already a port, and the frames a render produces are already the frames that go to a client.
 * What was missing is the name — a shell says `search` and something has to say where `search` is
 * — and the check, because frames arriving from another deployment are somebody else's and a
 * length prefix does not say whose.
 *
 * So this file is two things and deliberately not a third. It resolves a region through the
 * registry and runs it through the executor the registry named, and it checks what came back
 * before any of it reaches a page. It is not a second render path: a region on `inline` takes the
 * same executor every other slot takes, which is what keeps the collapsed monolith the
 * best-tested shape rather than the one nobody runs.
 */
export class RegionError extends Error {
  code: string
  region: string

  constructor(code: string, region: string, message: string) {
    super(`${code} [${region}] — ${message}`)
    this.name = 'RegionError'
    this.code = code
    this.region = region
  }
}

/**
 * Frame kinds a region may not send, and why each one is somebody else's to send.
 *
 * This is the list that makes composition safe rather than the list that makes it work, so every
 * entry states the authority it would be borrowing. A region is a fragment inside a page it did
 * not assemble, cannot see the rest of, and does not own the connection to — and each refusal
 * below is one of those three facts.
 *
 * Frames travelling the wrong way are already refused by the decoder, which is why no uplink
 * frame appears here: `E_WRONG_DIRECTION` fires before this table is consulted.
 */
const REFUSED: Partial<Record<FrameKind, string>> = {
  WARP: 'negotiation is between the composite and its client, and a region does not send the frames it would be settling a version for',
  SHELL:
    'the shell belongs to the composite, and a region that could send one could replace the page it is part of',
  PLAN: 'a plan is a route table, and a region knows one route on one deployment',
  NAV: 'only the side holding both shells can answer a staged route, and a region holds one',
  COMMIT: 'an epoch commits a whole page atomically, so the flip belongs to whoever owns the page',
  REDIRECT: 'a region cannot move the page it is inside',
  COOKIE: 'a region cannot write to the composite’s reader',
  ACK: 'an intent’s answer belongs to the deployment that dispatched the intent',
}

/**
 * `STALE` used to be on that list, and the reason it gave was half right.
 *
 * "Push invalidation names connections, and a region holds none of this composite's" — true, and
 * not a reason to refuse the frame. A region naming a *sibling's* slot is refused by the escape
 * check like everything else; a region naming **its own hole** is saying the only thing it is in a
 * position to know, which is that what it served is no longer current. Which connections are
 * showing that hole is the composite's to answer, and `ChannelHub.notifySlots` is that answer.
 *
 * What is still not a region's to send is the *drop*. Nothing leaves any store here: the region's
 * markup came down a wire and this deployment has none of its keys. The client is told, and the
 * client decides — which is the same contract a local `STALE` has.
 */

/** What a region said about itself, taken from the one frame it is allowed to open with. */
export interface RegionAnnouncement {
  region: string
  contract?: RegionContract
  revision?: string
  /** Boundaries the region crossed on its own account. A region composing regions is a tree. */
  hops: number
}

/**
 * The effect set a composite uses for a region, which is where a region's cache class comes from.
 *
 * Derived on the other side and carried in the contract, never declared here — the composite runs
 * the region's reads through the same `cacheClassOf` and `varyOn` as a local fragment's. A region
 * that described nothing reads `opaque`: uncacheable, private, and therefore unable to make the
 * document containing it look shareable. Unknown is not nothing.
 */
export function regionEffects(contract?: RegionContract): EffectSet {
  const reads = contract?.reads ? [...contract.reads].sort() : ['opaque']
  return { reads, writes: [], envelope: [], residency: 'server' }
}

/** The frames a region answered with, before anything in them has been trusted. */
export interface RegionFrames {
  announced: RegionAnnouncement
  /** Markup for the shell's hole: the bodies of the region's own `HTML` frames, in order. */
  html: Uint8Array
  /** Everything else the region sent, checked and safe to forward to a client. */
  frames: Frame[]
  /** Set when the region itself reported a failure, which is a degradation and not a protocol error. */
  error?: { code: string; message: string }
}

/**
 * Read what a region answered, and refuse anything it was not entitled to say.
 *
 * Three checks, and the order matters. The stream has to announce itself, because an unannounced
 * stream is an unattributable one. The announcement has to name the region that was *asked for*,
 * because the alternative is a registry entry deciding which hole it fills. And every frame after
 * it has to name a slot inside that region, because writing into a sibling's hole is the actual
 * security hole in "rendering as a service", not a hypothetical one.
 */
export function readRegion(region: string, bytes: Uint8Array, contract?: RegionContract): RegionFrames {
  let decoded: AnyFrame[]
  try {
    const decoder = createBinaryDecoder({ expect: 'down' })
    decoded = decoder.push(bytes)
    decoder.end()
  } catch (error) {
    throw new RegionError('E_REGION_UNREADABLE', region, (error as Error).message)
  }

  const first = decoded[0]
  if (!first || first.kind !== 'REGION') {
    throw new RegionError(
      'E_REGION_UNANNOUNCED',
      region,
      'a composed region opens with a REGION frame naming itself; this stream opens with ' +
        (first ? first.kind : 'nothing'),
    )
  }
  const named = str(first, 'region')
  if (named !== region) {
    throw new RegionError(
      'E_REGION_ESCAPE',
      region,
      `announced itself as '${named ?? '(unnamed)'}', which is not the region that was asked for`,
    )
  }

  const version = str(first, 'version')
  const id = str(first, 'contract')
  const reads = list(first, 'reads')
  const announced: RegionAnnouncement = {
    region,
    hops: num(first, 'hops') ?? 0,
    ...(id && version ? { contract: { id, version, ...(reads.length ? { reads } : {}) } } : {}),
    ...(str(first, 'rev') ? { revision: str(first, 'rev') as string } : {}),
  }

  if (contract && (id !== contract.id || version !== contract.version)) {
    throw new RegionError(
      'E_REGION_CONTRACT',
      region,
      `serves ${id ?? '(none)'}@${version ?? '(none)'} and this shell was built against ` +
        `${contract.id}@${contract.version}. A contract checked in CI closes the window before a ` +
        `deploy; this is the window after one`,
    )
  }

  // The reads are the half of a contract that decides a *header*, so a version that matched while
  // the reads had changed underneath it would be worse than a mismatch: the composite has already
  // advertised the document's class and `Vary` from what the contract said. A region whose reads
  // moved without its version moving is refused for that reason, and the page keeps the answer it
  // already committed to.
  if (contract?.reads && !sameReads(contract.reads, reads)) {
    throw new RegionError(
      'E_REGION_CONTRACT',
      region,
      `reads ${reads.join(', ') || '(none stated)'} and this shell derived a cache class and a ` +
        `Vary from ${[...contract.reads].sort().join(', ')} before the region answered`,
    )
  }

  const frames: Frame[] = []
  const html: Uint8Array[] = []
  let error: { code: string; message: string } | undefined

  for (const f of decoded.slice(1)) {
    // An unknown kind is skippable by construction — that is what the length prefix is for, and
    // it is how a region on a later minor stays composable by an older shell.
    if (isUnknown(f)) continue
    if (f.kind === 'REGION') {
      throw new RegionError('E_REGION_FRAME', region, 'a region announces itself once')
    }
    const why = REFUSED[f.kind]
    if (why) throw new RegionError('E_REGION_FRAME', region, `sent ${f.kind}: ${why}`)

    // A `SIGNAL` naming no slot is the composite's: it carries a name out of the exposed-value
    // namespace, and an unscoped one from a region would let it set a value its siblings read.
    if (f.kind === 'SIGNAL' && !str(f, 's')) {
      throw new RegionError(
        'E_REGION_ESCAPE',
        region,
        `sent a SIGNAL naming no slot. An unscoped signal is the composite's — it is how a shell ` +
          `exposes a value to its regions — so a region's own must carry s=${region}`,
      )
    }

    for (const name of slotsNamed(f)) {
      if (name !== region && !name.startsWith(`${region}:`)) {
        throw new RegionError(
          'E_REGION_ESCAPE',
          region,
          `named slot '${name}', which is not this region or a slot inside it`,
        )
      }
    }

    if (f.kind === 'ERROR') {
      error ??= { code: str(f, 'code') ?? 'E_REGION_FAILED', message: str(f, 'reason') ?? 'no reason given' }
      continue
    }
    if (f.kind === 'HTML' && str(f, 's') === region) {
      if (f.body) html.push(f.body)
      continue
    }
    frames.push(f)
  }

  return { announced, html: join(html), frames, ...(error ? { error } : {}) }
}

function sameReads(a: readonly string[], b: readonly string[]): boolean {
  const left = [...a].sort()
  const right = [...b].sort()
  return left.length === right.length && left.every((read, i) => read === right[i])
}

/** Slot names a frame claims, from the one header every frame that addresses a slot uses. */
function slotsNamed(f: Frame): string[] {
  const s = str(f, 's')
  return s ? s.split(',').filter(Boolean) : []
}

function join(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0] as Uint8Array
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/**
 * The other end of the check above: what a region says about itself before it says anything else.
 * A `REGION` frame answering a probe carries the subtree instead — that form lives in `region-tree.ts`.
 */
export function announceRegion(announcement: RegionAnnouncement): Frame {
  const header = {
    region: announcement.region,
    hops: announcement.hops,
    ...(announcement.contract
      ? { contract: announcement.contract.id, version: announcement.contract.version }
      : {}),
    ...(announcement.contract?.reads?.length
      ? { reads: [...announcement.contract.reads].sort().join(',') }
      : {}),
    ...(announcement.revision ? { rev: announcement.revision } : {}),
  }
  return frame('REGION', header)
}

/** A region's whole answer: the announcement, then its frames, as one Warp stream. */
export function regionStream(announcement: RegionAnnouncement, frames: readonly Frame[]): Uint8Array {
  return new Uint8Array(encodeStream([announceRegion(announcement), ...frames]))
}

/** What a region is being asked to render. Data, because it has to survive a serialisation. */
export interface RegionRequest {
  /** The route the composite is serving. A region renders per route like every other fragment. */
  route?: string
  params?: Record<string, string>
  /**
   * The reads the region's contract declared, resolved for this request by the composite. A region
   * is *given* its reads rather than taking them — the whole reason a composed page can be cached.
   * See `spec/kernel/composition.md`.
   */
  reads?: Record<string, string>
  /** Template versions the client already holds, so a region can answer with a delta. */
  held?: readonly string[]
  /** Set when the composite is staging rather than painting. A region does not decide this. */
  epoch?: string
  /**
   * Set when the region is being asked *what it is* rather than for a page. `weft verify --probe`
   * only. The depth bounds a recursive composition from the side that started it.
   */
  probe?: { depth: number }
  /**
   * Shell signals this region declared it consumes, at their current values. One-way by
   * construction: a region has no way to write back.
   */
  exposed?: Record<string, string>
}

/**
 * A region's declared reads, resolved through the same context a local fragment's would be — so the
 * document's key and `Vary` describe the region's reads whether it is local or across a socket.
 */
export async function readsFor(
  ctx: Reads,
  contract?: RegionContract,
): Promise<Record<string, string> | undefined> {
  if (!contract?.reads?.length) return undefined
  const out: Record<string, string> = {}
  for (const read of contract.reads) {
    if (read.startsWith('cookie:')) out[read] = ctx.cookie(read.slice(7)) ?? ''
    else if (read.startsWith('header:')) out[read] = ctx.header(read.slice(7)) ?? ''
    else if (read.startsWith('route:')) {
      const key = read.slice(6)
      out[read] = ctx.param(key) ?? ctx.query(key) ?? ''
    } else if (read.startsWith('flag:')) out[read] = String(await ctx.flag(read.slice(5)))
    else if (read === 'locale') out[read] = ctx.locale()
    else if (read === 'device') out[read] = ctx.device()
    else if (read === 'identity') out[read] = (await ctx.user()) ?? ''
    // `time` and `opaque` resolve to nothing: the clock is a TTL, and `opaque` is the absence of
    // a description.
    else if (read !== 'time' && read !== 'opaque') {
      throw new RegionError(
        'E_UNRESOLVABLE_READ',
        contract.id,
        `declares the read '${read}', which is not one this composite can resolve for it`,
      )
    }
  }
  return out
}

/**
 * What the shell declares about a region: everything about *failure* and nothing about where it
 * runs. `optional` and `fallback` are the same `onExceed` vocabulary a slot already has.
 */
export interface RegionSpec {
  region: string
  onExceed?: ExceedPolicy
  fallback?: Uint8Array
  placeholder?: Uint8Array
  /** Milliseconds. On `inline` a report; on a binding or service a deadline on *waiting* — the render keeps running where it lives. */
  cpuBudgetMs?: number
  /** What this shell was built expecting. Checked against what the region says it serves. */
  contract?: RegionContract
}

/** What one region cost and where it ran, including a failure and what it degraded to. */
export interface RegionOutcome {
  region: string
  /** Markup for the hole. Empty when the region degraded to nothing, which `optional` means. */
  bytes: Uint8Array
  /** Frames for the client: templates, modules, stylesheets, signals the region exposed. */
  frames: readonly Frame[]
  ms: number
  /** Deployment boundaries crossed, including the region's own. Zero in a monolith. */
  hops: number
  executor: string
  revision?: string
  failure?: { code: string; message: string }
}

/** What composing needs: the registry, the executors, and the contract each region must satisfy. */
export interface ComposeOptions {
  /** Narrower than `Ports`: a composer needs a registry, somewhere to run, somewhere to report —
   * the shape a nested tier has. */
  ports: Pick<Ports, 'registry' | 'executors' | 'telemetry'>
  /**
   * Regions this process renders itself, keyed by region name — the monolith. A local region is
   * not a special case here, it is a registry entry whose executor is `inline`.
   */
  local?: Record<string, (request: RegionRequest, signal: AbortSignal) => Promise<Uint8Array> | Uint8Array>
}

/** Composes regions into a page, checking each one's frames before any of it reaches the reader. */
export interface Composer {
  compose(spec: RegionSpec, request?: RegionRequest): Promise<RegionOutcome>
  /** Every region composed by this instance, in the order they were asked for. */
  readonly composed: readonly RegionOutcome[]
  /** Boundaries crossed serving this page. The number the design says should not be discovered under load. */
  readonly hops: number
}

/**
 * A composer over this deployment's ports: a region is a local async function, and the boundary is
 * the executor the registry named one level in.
 */
export function createComposer(options: ComposeOptions): Composer {
  const composed: RegionOutcome[] = []
  const inline = inlineExecutor(options.ports.telemetry)

  const executorFor = (name: string, region: string): KernelExecutor => {
    if (name === 'inline') return inline
    const bound = options.ports.executors[name]
    if (!bound) {
      throw new RegionError(
        'E_UNKNOWN_EXECUTOR',
        region,
        `the registry resolves it to '${name}', which this deployment does not bind`,
      )
    }
    return bound as KernelExecutor
  }

  const resolve = async (region: string): Promise<RegionBinding> => {
    const registry = options.ports.registry
    if (!registry?.region) {
      throw new RegionError(
        'E_NO_REGION_REGISTRY',
        region,
        'no registry able to resolve a region is bound. A shell composing regions needs one, and ' +
          'a table compiled into the shell would make a roll a redeploy',
      )
    }
    const binding = await registry.region(region)
    if (!binding) {
      throw new RegionError(
        'E_NO_SUCH_REGION',
        region,
        `the ${registry.name} registry resolves no region by that name`,
      )
    }
    return binding
  }

  return {
    composed,
    get hops() {
      return composed.reduce((n, outcome) => n + outcome.hops, 0)
    },

    async compose(spec, request = {}) {
      const region = spec.region
      const binding = await resolve(region)
      const executor = executorFor(binding.executor, region)
      const local = options.local?.[region]

      if (binding.executor === 'inline' && !local) {
        throw new RegionError(
          'E_NO_LOCAL_REGION',
          region,
          'the registry resolves it to this process and this process renders no such region. A ' +
            'monolith is a topology, not an absence of one',
        )
      }

      const outcome = await executor.run({
        slot: region,
        ...(spec.cpuBudgetMs !== undefined ? { cpuBudgetMs: spec.cpuBudgetMs } : {}),
        ...(binding.address
          ? { address: { ...binding.address, props: { ...(binding.address.props as object), ...request } } }
          : {}),
        // Only `inline` ever calls this: everything else needs an address, refuses without one.
        run: async (signal) => {
          if (!local) {
            throw new RegionError(
              'E_REGION_NOT_LOCAL',
              region,
              `runs on '${binding.executor}', which cannot receive a closure`,
            )
          }
          return local(request, signal)
        },
      })

      const failed = (failure: { code: string; message: string }, hops: number): RegionOutcome => {
        options.ports.telemetry?.measure('region.degraded', outcome.ms, {
          region,
          executor: binding.executor,
          code: failure.code,
        })
        return {
          region,
          bytes: degrade(
            {
              slot: region,
              policy: spec.onExceed ?? 'placeholder',
              ...(spec.fallback ? { fallback: spec.fallback } : {}),
              ...(spec.placeholder ? { placeholder: spec.placeholder } : {}),
            },
            failure,
          ),
          frames: [],
          ms: outcome.ms,
          hops,
          executor: binding.executor,
          ...(binding.revision ? { revision: binding.revision } : {}),
          failure,
        }
      }

      const boundary = binding.executor === 'inline' ? 0 : 1
      let result: RegionOutcome
      if (outcome.failure) {
        result = failed(outcome.failure, boundary)
      } else {
        try {
          const read = readRegion(region, outcome.bytes, spec.contract)
          const hops = boundary + read.announced.hops
          result = read.error
            ? failed(read.error, hops)
            : {
                region,
                bytes: read.html,
                frames: read.frames,
                ms: outcome.ms,
                hops,
                executor: binding.executor,
                ...((read.announced.revision ?? binding.revision)
                  ? { revision: read.announced.revision ?? binding.revision }
                  : {}),
              }
        } catch (error) {
          // A protocol refusal degrades the region rather than failing the page. See
          // `spec/kernel/composition.md`.
          const e = error as RegionError
          result = failed({ code: e.code ?? 'E_REGION_UNREADABLE', message: e.message }, boundary)
        }
      }

      composed.push(result)
      if (!result.failure) {
        options.ports.telemetry?.measure('region.composed', result.ms, {
          region,
          executor: binding.executor,
          hops: result.hops,
        })
      }
      return result
    },
  }
}
