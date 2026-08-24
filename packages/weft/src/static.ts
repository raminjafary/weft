import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cookieSession, memoryStore, staticFlags } from '@weft/adapters'
import { createKernel, createRouter, type Ports, type RouteResolver } from '@weft/kernel'
import { fastHash, short, type TemplateIR } from '@weft/ir'
import type { CompiledFragment } from './compile.ts'
import type { ResolvedConfig } from './config.ts'
import type { RouteModule, SlotDeclaration } from './route.ts'
import type { App } from './serve.ts'

/**
 * L0: the tier where the kernel is not involved at all.
 *
 * The design's cheapest tier is a document that reads nothing, resolved once at build time and
 * served as a file. It was the last unimplemented thing in the cache ladder, and the reason it
 * stayed unimplemented is that "reads nothing" is easy to assert and hard to *prove*: the
 * compiler infers the read set of a fragment, and a route also runs a loader, a head function
 * and an html thunk that no compiler saw. A page whose fragments read nothing and whose loader
 * reads a cookie is not static, and nothing in the effect set says so.
 *
 * So eligibility is decided twice, and a document is only written when both agree.
 *
 * **Structurally**, from what the compiler and the plan already know: every fragment on the page
 * reads nothing, no instance is isolated, nothing is live or refreshed, no guard runs, no budget
 * is a function of the request, the route takes no parameters, and the slots buffer.
 *
 * **Empirically**, by rendering the route twice through the real kernel under two requests that
 * differ in everything a document is allowed to be indifferent to — cookies, locale, device,
 * identity, flags, query string and the clock — and requiring the bytes to come out identical.
 * That is what catches the loader the compiler never saw, and it is a measurement rather than a
 * declaration, which is the standard the rest of this repository is held to.
 *
 * What is still not caught is stated rather than hidden: a loader that reads the wall clock or
 * the environment directly, behind the framework's back, is the case the compiler's untracked-
 * effect ban exists to prevent — and `.data.ts` is not compiled, so the ban does not reach it.
 * The differential probe catches such a read only when it reaches the bytes.
 */
export type StaticRefusal =
  | 'L0_PARAMS'
  | 'L0_READS'
  | 'L0_ISOLATED'
  | 'L0_LIVE'
  | 'L0_REFRESH'
  | 'L0_GUARD'
  | 'L0_BUDGET_FOR'
  | 'L0_OUT_OF_ORDER'
  | 'L0_VARIES'
  | 'L0_DEGRADED'
  | 'L0_STATUS'
  | 'L0_SET_COOKIE'
  | 'L0_REGION'
  | 'L0_FAILED'

export type StaticVerdict = { static: true } | { static: false; code: StaticRefusal; reason: string }

export interface StaticInput {
  pattern: string
  module: RouteModule
  /** The layout. Its own reads are the document's exactly as a slot's are. */
  shell: CompiledFragment
  slots: {
    name: string
    /** Absent for a region rendered on another deployment, which is refused before it is read. */
    fragment?: CompiledFragment
    declaration: SlotDeclaration
    streams: boolean
  }[]
}

function readsOf(fragment: CompiledFragment): string[] {
  return [...fragment.entry.effects.reads]
}

function isolatedIn(fragment: CompiledFragment): TemplateIR | undefined {
  return fragment.templates.find((template) => template.holes.some((hole) => hole.isolated))
}

/**
 * The structural half, decided where the route is generated and carried on it.
 *
 * Each refusal names the page's own vocabulary — the fragment, the slot, the declaration — rather
 * than the mechanism, because the reader is someone asking why their page is not a file.
 */
export function staticVerdict(input: StaticInput): StaticVerdict {
  const { pattern, module: declared, shell, slots } = input

  if (pattern.includes(':') || pattern.includes('*')) {
    return {
      static: false,
      code: 'L0_PARAMS',
      reason: `${pattern} takes a parameter, so it has no single URL a file could answer`,
    }
  }

  /**
   * A page composed out of another deployment's regions is not a file, and it is refused before
   * anything is measured.
   *
   * The empirical half cannot settle this: two renders of a composed page could agree by accident
   * because the region happened to answer identically twice, and a document written on that
   * evidence would be a cache of somebody else's deployment. What the region reads is its own and
   * it can be rolled without this build knowing, so the honest answer is structural.
   */
  const composed = slots.find((slot) => slot.declaration.region?.remote)
  if (composed) {
    return {
      static: false,
      code: 'L0_REGION',
      reason: `region '${composed.name}' renders on another deployment, whose answer this build cannot prove invariant and whose revision can be rolled without rebuilding this page`,
    }
  }

  for (const fragment of [shell, ...slots.map((slot) => slot.fragment)]) {
    if (!fragment) continue
    const reads = readsOf(fragment)
    if (reads.length) {
      return {
        static: false,
        code: 'L0_READS',
        reason: `${fragment.file} reads ${reads.join(', ')}, so its bytes are a function of the request`,
      }
    }
    const isolated = isolatedIn(fragment)
    if (isolated) {
      return {
        static: false,
        code: 'L0_ISOLATED',
        reason: `${fragment.file} composes a private instance the kernel fills separately, so the document is not one cached thing`,
      }
    }
  }

  for (const slot of slots) {
    if (slot.declaration.live) {
      return {
        static: false,
        code: 'L0_LIVE',
        reason: `slot '${slot.name}' is live, and a region that is refreshed over the channel is not a file`,
      }
    }
    if (slot.declaration.refresh !== undefined) {
      return {
        static: false,
        code: 'L0_REFRESH',
        reason: `slot '${slot.name}' declares a refresh interval, which says its value changes`,
      }
    }
    if (slot.declaration.budgetFor) {
      return {
        static: false,
        code: 'L0_BUDGET_FOR',
        reason: `slot '${slot.name}' takes its budget from the request, so what it renders can too`,
      }
    }
    if (slot.streams) {
      return {
        static: false,
        code: 'L0_OUT_OF_ORDER',
        reason: `slot '${slot.name}' streams, and an out-of-order document is filled in completion order — which is a property of the render rather than of the page. Buffer them: a page with nothing slow on it gives up nothing by doing so`,
      }
    }
  }

  if (declared.guard) {
    return {
      static: false,
      code: 'L0_GUARD',
      reason: `${pattern} has a guard, which decides in the envelope phase and therefore per request`,
    }
  }

  return { static: true }
}

/** One document, resolved. The manifest is what a deployment reads; the body is the file. */
export interface StaticDocument {
  pattern: string
  /** The path it answers, which for a route with no parameters is the pattern. */
  path: string
  /** Relative to the static directory, so the directory can be uploaded as it is. */
  file: string
  bytes: number
  etag: string
  /** What the build's own render produced, minus the parts a file decides for itself. */
  headers: Record<string, string>
}

export interface StaticManifest {
  documents: StaticDocument[]
  refused: { pattern: string; code: StaticRefusal; reason: string }[]
}

export interface Prerendered {
  documents: (StaticDocument & { body: Uint8Array })[]
  refused: { pattern: string; code: StaticRefusal; reason: string }[]
}

/** Where the build writes documents, and where `weft start` looks for them. */
export const STATIC_DIR = 'static'

export function fileFor(pattern: string): string {
  return pattern === '/' ? 'index.html' : `${pattern.replace(/^\/|\/$/g, '')}/index.html`
}

/**
 * The two requests a static document has to be indifferent to.
 *
 * Everything varied here is something the framework can vary: a header it reads, a cookie the
 * session port parses, a flag it resolves, a query it exposes, and the clock it hands to
 * `ctx.now()`. A document that comes out the same under both is a document that does not
 * depend on any of them — which is a stronger statement than the effect set alone can make,
 * because the effect set does not cover the route's own loader.
 */
interface Probe {
  label: string
  headers?: Record<string, string>
  query?: string
  /** Flags resolve to the last declared value rather than the first. */
  flip?: boolean
  clock?: number
}

const BUILD_CLOCK = 1_700_000_000_000
const LATER = BUILD_CLOCK + 10 * 365 * 24 * 60 * 60 * 1000

const HOSTILE: Probe = {
  label: 'everything at once',
  headers: {
    cookie: 'sid=probe.1; currency=USD; theme=dark',
    'accept-language': 'ar-IQ,ar;q=0.9',
    'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
    'sec-ch-ua-mobile': '?1',
    'x-tier': 'gold',
    referer: 'https://example.invalid/elsewhere',
  },
  query: '?weft-probe=1&sort=price',
  flip: true,
  clock: LATER,
}

/**
 * The same variation, one axis at a time. Only run for a route that failed the combined probe,
 * so the report can say *what* the document depends on rather than that it depends on something.
 */
const AXES: Probe[] = [
  { label: 'a cookie', headers: { cookie: 'sid=probe.1; currency=USD; theme=dark' } },
  { label: 'the locale', headers: { 'accept-language': 'ar-IQ,ar;q=0.9' } },
  {
    label: 'the device',
    headers: {
      'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
      'sec-ch-ua-mobile': '?1',
    },
  },
  { label: 'a header', headers: { 'x-tier': 'gold', referer: 'https://example.invalid/elsewhere' } },
  { label: 'the query string', query: '?weft-probe=1&sort=price' },
  { label: 'a flag', flip: true },
  { label: 'the clock', clock: LATER },
]

function portsFor(config: ResolvedConfig, probe: Probe): Ports {
  const axes = config.flags
  return {
    // A store of its own, per render. Sharing one would defeat the whole probe: a static key is
    // the fragment's content address and nothing else, so the second render would be answered
    // from the first one's entry and every document would look invariant.
    store: memoryStore({ maxBytes: 16 * 1024 * 1024 }),
    session: cookieSession({ cookie: config.session.cookie }),
    flags: staticFlags({
      axes,
      ...(probe.flip ? { bucket: (flag: string) => axes[flag]?.at(-1) } : {}),
    }),
    executors: config.executors,
  }
}

async function renderOnce(
  app: App,
  pattern: string,
  probe: Probe,
): Promise<{ body: Uint8Array; status: number; headers: Headers; degraded: string[] }> {
  const table = createRouter<RouteResolver>(app.routes.map((route) => route.entry))
  const kernel = createKernel({
    ports: portsFor(app.config, probe),
    routes: table,
    clock: () => probe.clock ?? BUILD_CLOCK,
  })
  const url = `http://weft.build${pattern}${probe.query ?? ''}`
  const response = await kernel.serve(new Request(url, { headers: probe.headers ?? {} }))
  const body = new Uint8Array(await response.arrayBuffer())
  return {
    body,
    status: response.status,
    headers: response.headers,
    degraded: (kernel.trace?.degraded ?? []).map(
      (failure) => `${failure.slot}: ${failure.code} — ${failure.message}`,
    ),
  }
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * The headers a file is served with.
 *
 * Content type and `Vary` are the render's own. `Cache-Control` is not, and the difference is
 * deliberate: with no declared policy the kernel emits `no-store`, because a kernel cannot know
 * whether the thing it just rendered may be held. Here it can — the document was just proved
 * invariant under every axis the framework can vary — and `no-store` would contradict the ETag
 * that goes with it. A route that declares a policy still gets the one it declared.
 */
function headersFor(rendered: Headers): Record<string, string> {
  const out: Record<string, string> = {
    'content-type': rendered.get('content-type') ?? 'text/html; charset=utf-8',
  }
  const vary = rendered.get('vary')
  if (vary) out.vary = vary
  const control = rendered.get('cache-control')
  out['cache-control'] = !control || control === 'no-store' ? 'public, max-age=0, must-revalidate' : control
  return out
}

export async function prerender(app: App): Promise<Prerendered> {
  const documents: Prerendered['documents'] = []
  const refused: Prerendered['refused'] = []

  for (const route of app.routes) {
    if (!route.static.static) {
      refused.push({ pattern: route.pattern, code: route.static.code, reason: route.static.reason })
      continue
    }

    let plain
    let hostile
    try {
      plain = await renderOnce(app, route.pattern, { label: 'a bare request' })
      hostile = await renderOnce(app, route.pattern, HOSTILE)
    } catch (error) {
      refused.push({
        pattern: route.pattern,
        code: 'L0_FAILED',
        reason: `rendering it at build time threw: ${(error as Error).message}`,
      })
      continue
    }

    if (plain.status !== 200) {
      refused.push({
        pattern: route.pattern,
        code: 'L0_STATUS',
        reason: `it answered ${plain.status}, and only a 200 is a document`,
      })
      continue
    }
    if (plain.degraded.length) {
      refused.push({
        pattern: route.pattern,
        code: 'L0_DEGRADED',
        reason: `a slot degraded while the build rendered it, and a placeholder frozen into a file is a failure that stops looking like one — ${plain.degraded.join('; ')}`,
      })
      continue
    }
    if (plain.headers.getSetCookie().length) {
      refused.push({
        pattern: route.pattern,
        code: 'L0_SET_COOKIE',
        reason: 'it sets a cookie, and a cookie baked into a file is one visitor handing theirs to everybody',
      })
      continue
    }
    if (!same(plain.body, hostile.body)) {
      refused.push({
        pattern: route.pattern,
        code: 'L0_VARIES',
        reason: `its bytes change with ${await culprit(app, route.pattern, plain.body)}. Something it renders reads the request without the compiler seeing it — a loader, an html thunk or a head function`,
      })
      continue
    }

    const body = plain.body
    documents.push({
      pattern: route.pattern,
      path: route.pattern,
      file: fileFor(route.pattern),
      bytes: body.byteLength,
      etag: `"${short(fastHash(Buffer.from(body).toString('base64')), 16)}"`,
      headers: headersFor(plain.headers),
      body,
    })
  }

  return { documents, refused }
}

/** Which single axis the document turned out to depend on. Named, because "something" is not a fix. */
async function culprit(app: App, pattern: string, baseline: Uint8Array): Promise<string> {
  const found: string[] = []
  for (const probe of AXES) {
    try {
      const rendered = await renderOnce(app, pattern, probe)
      if (!same(baseline, rendered.body)) found.push(probe.label)
    } catch {
      found.push(`${probe.label} (which also failed to render)`)
    }
  }
  return found.length ? found.join(', ') : 'nothing this probe varies, so it does not render the same twice'
}

/** What `weft start` serves: the file, the headers the build captured, and its ETag. */
export interface ServedDocument {
  body: Buffer
  headers: Record<string, string>
  etag: string
}

/**
 * The build's documents, loaded back.
 *
 * A deployment that never ran `weft build` has none, and that is not an error: `weft start`
 * refuses a missing IR manifest already, and a static directory is a tier rather than a
 * requirement. What would be an error is a manifest naming a file that is not there, because the
 * route would then answer with nothing while the build report says it is a file.
 */
export async function loadDocuments(config: ResolvedConfig): Promise<Map<string, ServedDocument>> {
  const dir = join(config.root, config.outDir, STATIC_DIR)
  let manifest: StaticManifest
  try {
    manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as StaticManifest
  } catch {
    return new Map()
  }

  const out = new Map<string, ServedDocument>()
  for (const document of manifest.documents) {
    let body: Buffer
    try {
      body = await readFile(join(dir, document.file))
    } catch {
      throw new Error(
        `E_MISSING_DOCUMENT: ${config.outDir}/${STATIC_DIR}/${document.file} is in the manifest and not on disk. Run \`weft build\``,
      )
    }
    out.set(document.path, { body, headers: document.headers, etag: document.etag })
  }
  return out
}
