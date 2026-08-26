import { pathToFileURL } from 'node:url'
import { intentId } from '@weft/compiler'
import type { Values } from '@weft/ir'
import type { IntentLimit, Ports, Renderable, RenderRequest, SlotFrames, SlotRender } from '@weft/kernel'
import type { CompiledApp } from './compile.ts'
import { withServices } from './context.ts'
import type { LoaderContext } from './context.ts'

/**
 * The catalogue, generated from a directory.
 *
 * `app/renderables/**.ts` is to a render intent what `app/intents/**.ts` is to a mutation, down to
 * the derivation: the id is `intentId(module, export)`, the same six hex characters the compiler
 * writes into a template's wiring, so nothing states an id twice and moving the file changes the
 * wire — deliberately, because a renderable's location is part of its address.
 *
 * Two things make this a catalogue rather than an open render endpoint, and both are the reason it
 * needed the registry before it could exist at all.
 *
 * **A fragment is not renderable because it is compiled.** `app/fragments/` holds everything a page
 * composes; this directory holds what a *browser* may ask for. Making the second set the first one
 * would turn every component in an application into a public endpoint taking arbitrary props.
 *
 * **The id resolves through a port.** So an entry served by this process today can be served by a
 * region on another deployment tomorrow, and the client cannot tell — which is the design's
 * "rendering as a service, by passing component names over the wire" with the two properties that
 * make it safe: the name is opaque and derived, and what comes back is checked before it reaches a
 * page.
 */
export type RenderableLoad<I> = (
  ctx: LoaderContext,
  params: I,
) => Values | Promise<Values> | Record<string, unknown> | Promise<Record<string, unknown>>

/** A fragment a client may ask for by opaque id, and the gates that ask applies. */
export interface RenderableDeclaration<I = unknown> {
  /** Human-readable, for a log and for the build report. Never on the wire. */
  name: string
  /** Which fragment renders it, by name under `app/fragments/`. */
  fragment?: string
  /**
   * Or: the region that serves it, by name, resolved through the registry like any other region.
   *
   * The half that makes this a catalogue. An entry named here is rendered by whichever deployment the
   * registry currently points that region at, so moving it is a registry write — and the client, which
   * only ever had an opaque id, is not involved in either arrangement.
   */
  region?: string
  /** Capabilities the caller must hold. Unchecked capabilities are refused, not waved through. */
  capabilities?: readonly string[]
  /** Reachable only with a signed, expiring token this deployment minted. */
  signed?: boolean
  /**
   * How much of this one caller may ask for.
   *
   * The one call a client can make that costs server work without writing anything, so it is the one
   * that most wants a limit. What it is counted against is the `limits` port's, as everywhere else.
   */
  limit?: IntentLimit
  /** Parse and validate the raw params. Throwing here is `E_RENDER_INPUT`, not a 500. */
  input?(raw: unknown): I
  /** The values the fragment renders with. Absent renders it with none, which is right for a static one. */
  load?: RenderableLoad<I>
}

/** Identity, typed. The build reads the object; nothing here runs on a request. */
export function defineRenderable<I>(declaration: RenderableDeclaration<I>): RenderableDeclaration<I> {
  return declaration
}

/** One entry: its id, what renders it, and what a caller must hold to ask for it. */
export interface CatalogueEntry {
  module: string
  export: string
  /** Six hex characters, derived from the two fields above and from nothing else. */
  id: string
  name: string
  /** What renders it: a compiled fragment in this process, or a region the registry resolves. */
  by: string
  capabilities: string[]
  signed: boolean
  limit?: IntentLimit
}

/**
 * The closed set of fragments a browser may name.
 *
 * Closed on purpose: an id that resolves to nothing is a refusal, so a client cannot reach a
 * fragment somebody forgot was reachable. The ids are derived the same way an intent's are, so the
 * wire never carries a function name.
 */
export interface Catalogue {
  entries: CatalogueEntry[]
  /** By opaque id, which is what the registry answers with. */
  byId: Map<string, Renderable>
  /** Name to id, so a page can name one in markup a person wrote. */
  names: Record<string, string>
}

function looksLikeRenderable(value: unknown): value is RenderableDeclaration {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { name?: unknown; fragment?: unknown; region?: unknown }
  return (
    typeof candidate.name === 'string' &&
    (typeof candidate.fragment === 'string' || typeof candidate.region === 'string')
  )
}

/** A catalogue refusal — a duplicate id, an unreadable module, a declaration with no fragment. */
export class CatalogueError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(`${code} — ${message}`)
    this.name = 'CatalogueError'
    this.code = code
  }
}

/** Where the catalogue comes from: the `renderables/` directory, and what checks a request. */
export interface CatalogueOptions {
  root: string
  files: readonly string[]
  compiled: CompiledApp
  ports: Ports
  /** How a region-served entry is composed. Supplied by the front door, which owns the composer. */
  compose?(region: string, request: RenderRequest): Promise<SlotFrames | null>
  moduleIdOf(file: string): string
}

/** Load `app/renderables/**` into a closed set, refusing a collision rather than picking one. */
export async function loadCatalogue(options: CatalogueOptions): Promise<Catalogue> {
  const entries: CatalogueEntry[] = []
  const byId = new Map<string, Renderable>()
  const names: Record<string, string> = {}

  for (const file of options.files) {
    const module_ = (await import(pathToFileURL(file).href)) as Record<string, unknown>
    const moduleId = options.moduleIdOf(file)
    for (const [exportName, value] of Object.entries(module_)) {
      if (!looksLikeRenderable(value)) continue
      const id = intentId(moduleId, exportName)
      const clash = entries.find((e) => e.id === id)
      if (clash) {
        throw new CatalogueError(
          'E_RENDERABLE_ID_COLLISION',
          `${moduleId}#${exportName} and ${clash.module}#${clash.export} both hash to ${id}`,
        )
      }
      if (names[value.name]) {
        throw new CatalogueError(
          'E_RENDERABLE_NAME_TAKEN',
          `two renderables are called '${value.name}'. A name is what markup writes, so it has to be unique`,
        )
      }
      if (value.fragment && value.region) {
        throw new CatalogueError(
          'E_RENDERABLE_TWO_SOURCES',
          `'${value.name}' names both a fragment and a region, so two things claim to render it`,
        )
      }

      const fragment = value.fragment ? options.compiled.fragments[`fragment:${value.fragment}`] : undefined
      if (value.fragment && !fragment) {
        throw new CatalogueError(
          'E_NO_SUCH_FRAGMENT',
          `'${value.name}' names fragment '${value.fragment}', and app/fragments/${value.fragment}.tsx does not exist`,
        )
      }

      const load = value.load
      const renderable: Renderable = {
        name: value.name,
        ...(value.capabilities?.length ? { capabilities: value.capabilities } : {}),
        ...(value.signed ? { signed: true } : {}),
        ...(value.limit ? { limit: value.limit } : {}),
        ...(value.input ? { input: value.input } : {}),
        render: async (request): Promise<SlotRender | SlotFrames> => {
          if (value.region) {
            const frames = await options.compose?.(value.region, request)
            if (!frames) {
              throw new CatalogueError(
                'E_NO_SUCH_REGION',
                `'${value.name}' is served by region '${value.region}' and this deployment's registry resolves none by that name`,
              )
            }
            return frames
          }
          const entry = fragment as NonNullable<typeof fragment>
          return {
            ir: entry.entry,
            values: load
              ? ((await load(withServices(request.ctx, options.ports), request.params as never)) as Values)
              : ({} as Values),
            ...(entry.resolve ? { resolve: entry.resolve } : {}),
            prefer: 'delta',
          }
        },
      }

      entries.push({
        module: moduleId,
        export: exportName,
        id,
        name: value.name,
        by: value.region ? `region:${value.region}` : `fragment:${value.fragment as string}`,
        capabilities: [...(value.capabilities ?? [])],
        signed: value.signed === true,
        ...(value.limit ? { limit: value.limit } : {}),
      })
      names[value.name] = id
      byId.set(id, renderable)
    }
  }

  return { entries, byId, names }
}
