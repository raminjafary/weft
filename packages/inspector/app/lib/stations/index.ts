import type { StationHandler } from './kind.ts'
import { cacheKeys, contagion, effects, portsStation, routing, shellBoundaries } from './inspect.ts'
import {
  adoption,
  controls,
  deltas as deltasStation,
  derived,
  intents,
  residency,
  signals,
  transport,
} from './client.ts'
import { byteBudgets, devices, sharedDeltas, wireForms } from './measure.ts'
import { staticDocuments } from './static.ts'
import { blockingControl, components, epochs, streaming, streamingOrder } from './stream.ts'
import {
  budgets,
  earlyHints,
  envelope,
  escaping,
  incremental,
  negotiation,
  stampede,
  warp,
  waves,
  workerPoolStation,
} from './runtime.ts'

/**
 * The station handlers, by id.
 *
 * `demo/test/stations.test.ts` asserts both directions: a station marked `live` must have a
 * handler here, and a handler here must belong to a station marked `live`. That is what stops the
 * index from advertising a page that does not run.
 */
export const HANDLERS: Record<string, StationHandler> = {
  'byte-budgets': byteBudgets,
  'shared-deltas': sharedDeltas,
  'wire-forms': wireForms,
  devices,
  effects,
  contagion,
  'cache-keys': cacheKeys,
  'static-documents': staticDocuments,
  routing,
  'shell-boundaries': shellBoundaries,
  ports: portsStation,
  waves,
  budgets,
  'worker-pool': workerPoolStation,
  incremental,
  negotiation,
  warp,
  escaping,
  envelope,
  'early-hints': earlyHints,
  stampede,
  streaming,
  'streaming-order': streamingOrder,
  'blocking-control': blockingControl,
  epochs,
  components,
  adoption,
  signals,
  derived,
  controls,
  deltas: deltasStation,
  residency,
  transport,
  intents,
}
