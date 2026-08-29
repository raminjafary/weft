import type { Adopted } from './adopt.ts'
import { applyDelta, type DeltaPayload } from './delta.ts'
import { batch } from './signal.ts'

/** The client half of epochs: data that has arrived and resolved but has not been painted. See `spec/kernel/transport.md`: "Epochs, over the wire". */
/** A change held for a slot, in one of the two forms a slot's next state can arrive in. See `spec/kernel/transport.md`. */
export interface StagedWrite {
  slot: string
  adopted: Adopted
  delta: DeltaPayload
}

/** A region staged as markup rather than as values, for a form no template can project. */
export interface StagedMarkup {
  slot: string
  html: string
  /** The render the region will be showing once this is painted. */
  base: string
  paint(html: string, base: string): void
}

/** One staged change: a value write, or markup for a whole region. */
export type Staged = StagedWrite | StagedMarkup

function isMarkup(staged: Staged): staged is StagedMarkup {
  return 'html' in staged
}

/** How to commit: with a view transition where the engine has one, instantly where it does not. */
export interface CommitOptions {
  /** Wrap the commit in a same-document View Transition where the engine has them. */
  transition?: boolean
}

/** What the commit did, and whether the engine animated it. */
export interface CommitResult {
  epoch: string
  slots: string[]
  writes: number
  /** False when the engine has no View Transitions, or when one was not asked for. */
  animated: boolean
}

/** Staged values, committed atomically or discarded. See `spec/kernel/transport.md`. */
export interface Epochs {
  stage(epoch: string, write: Staged): void
  commit(epoch: string, options?: CommitOptions): Promise<CommitResult>
  discard(epoch: string): number
  staged(epoch: string): string[]
  readonly open: string[]
}

type ViewTransitionHost = {
  startViewTransition?: (callback: () => void) => { finished: Promise<void> }
}

/** An epoch table. The host is injected so a test can commit without a real view transition. */
export function createEpochs(host?: ViewTransitionHost): Epochs {
  const staged = new Map<string, Map<string, Staged>>()
  const target =
    host ?? (typeof document === 'undefined' ? undefined : (document as unknown as ViewTransitionHost))

  return {
    get open() {
      return [...staged.keys()]
    },
    stage(epoch, write) {
      let bucket = staged.get(epoch)
      if (!bucket) {
        bucket = new Map()
        staged.set(epoch, bucket)
      }
      // One slot, one staged value per epoch: a later frame for the same slot supersedes
      // the earlier one rather than queueing a second write nobody would see.
      bucket.set(write.slot, write)
    },
    staged(epoch) {
      return [...(staged.get(epoch)?.keys() ?? [])]
    },
    discard(epoch) {
      const size = staged.get(epoch)?.size ?? 0
      staged.delete(epoch)
      return size
    },
    async commit(epoch, options = {}) {
      const bucket = staged.get(epoch)
      if (!bucket) return { epoch, slots: [], writes: 0, animated: false }
      staged.delete(epoch)
      const writes: Staged[] = [...bucket.values()]

      let count = 0
      const apply = (): void => {
        batch(() => {
          for (const write of writes) {
            if (isMarkup(write)) {
              // One write, whatever the region contains: replacing nodes is one operation, and
              // counting the values inside them would be counting something nobody wrote.
              write.paint(write.html, write.base)
              count++
              continue
            }
            count += applyDelta(write.adopted, write.delta)
          }
        })
      }

      const canAnimate = options.transition === true && typeof target?.startViewTransition === 'function'
      if (canAnimate) {
        await (target as Required<ViewTransitionHost>).startViewTransition(apply).finished
      } else {
        apply()
      }
      return { epoch, slots: writes.map((w) => w.slot), writes: count, animated: canAnimate }
    },
  }
}
