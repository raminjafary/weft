import type { Adopted } from './adopt.ts'
import { applyDelta, type DeltaPayload } from './delta.ts'
import { batch } from './signal.ts'

/**
 * The client half of epochs: data that has arrived and resolved but has not been painted.
 *
 * Everywhere else, fetching implies committing — a background revalidation repaints, and
 * prefetching a route can flicker the one you are looking at. Here a frame naming an epoch
 * lands in staging and paints nothing; a commit flips every slot staged in that epoch at
 * once, so the page never shows a half-updated state.
 *
 * Three things fall out rather than being built: prefetch cannot disturb the present,
 * revalidation can sit staged through a half-typed form, and an optimistic update is a
 * staged epoch committed immediately, so rollback is discarding an epoch rather than
 * reconstructing prior state.
 */
export interface StagedWrite {
  slot: string
  adopted: Adopted
  delta: DeltaPayload
}

export interface CommitOptions {
  /** Wrap the commit in a same-document View Transition where the engine has them. */
  transition?: boolean
}

export interface CommitResult {
  epoch: string
  slots: string[]
  writes: number
  /** False when the engine has no View Transitions, or when one was not asked for. */
  animated: boolean
}

export interface Epochs {
  stage(epoch: string, write: StagedWrite): void
  commit(epoch: string, options?: CommitOptions): Promise<CommitResult>
  discard(epoch: string): number
  staged(epoch: string): string[]
  readonly open: string[]
}

type ViewTransitionHost = {
  startViewTransition?: (callback: () => void) => { finished: Promise<void> }
}

export function createEpochs(host?: ViewTransitionHost): Epochs {
  const staged = new Map<string, Map<string, StagedWrite>>()
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
      const writes: StagedWrite[] = [...bucket.values()]

      let count = 0
      const apply = (): void => {
        batch(() => {
          for (const write of writes) count += applyDelta(write.adopted, write.delta)
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
