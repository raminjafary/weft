/**
 * Render intents: a catalogue of fragments a client may ask for by opaque id, over a live channel.
 *
 * The transport plus the catalogue, because that is the combination this capability actually is —
 * the point of doing it over a channel rather than as a fetch is the surgical ladder: a fragment
 * whose template the client already holds comes back as the changed values and nothing else.
 *
 * Its own entry on the rule route staging established. A deployment whose clients cannot name a
 * renderable never imports the dispatch, and its channel is the size it was; one that offers a
 * catalogue pays for it once and against a number of its own. Every gate it applies is the intent
 * path's — the same capability check, the same verifier, the same limiter — so the authority tier is
 * not measured twice either.
 */
export * from './entry-transport.ts'
export { createRenderDispatch, RenderIntentError } from './render-intent.ts'
export type {
  Renderable,
  RenderDispatch,
  RenderDispatchOptions,
  RenderIntentOutcome,
  RenderRequest,
} from './render-intent.ts'
