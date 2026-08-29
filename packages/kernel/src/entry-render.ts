/**
 * Render intents: a catalogue of fragments a client may ask for by opaque id, over a live channel
 * — transport plus the catalogue. Every gate it applies is the intent path's. See `spec/kernel/budgets.md`.
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
