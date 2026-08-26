import { frame, type Frame } from '@weft/warp'

/**
 * Fresh data without a changed view.
 *
 * Everywhere else, fetching implies committing: a background revalidation repaints, and a
 * prefetch that warms a shared cache can disturb the view you are looking at. Separating
 * data currency from view currency is the missing primitive, and an epoch is it.
 *
 * `live` is what is painted. Any number of staged epochs may exist alongside it, fully
 * resolved and completely invisible, until a COMMIT flips every slot staged in one of them
 * at once. Prefetch cannot disturb the present, revalidation can sit staged through a
 * half-typed form, and an optimistic update is a staged epoch committed immediately — so
 * rollback is discarding an epoch rather than reconstructing prior state.
 */
export type Transition = 'view' | 'instant'

/** An epoch refusal: too many open, or a commit of one that does not exist. */
export class EpochError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(`${code} — ${message}`)
    this.name = 'EpochError'
    this.code = code
  }
}

/** Staged writes, committed atomically or discarded. Bounded, because a staged epoch is memory. */
export interface Epochs {
  /** Stage a frame for a slot. The frame is rewritten to carry the epoch, so nothing paints. */
  stage(epoch: string, slot: string, f: Frame): void
  staged(epoch: string): Frame[]
  slots(epoch: string): string[]
  /** Every staged frame followed by the COMMIT that flips them, atomically. */
  commit(epoch: string, transition?: Transition): Frame[]
  discard(epoch: string): number
  readonly open: string[]
}

/** The epoch that is on screen. Writing to it is what a refresh does; everything else is staged. */
export const LIVE = 'live'

/** An epoch table for one connection. */
export function createEpochs(maxOpen = 8): Epochs {
  const staged = new Map<string, Map<string, Frame>>()

  return {
    get open() {
      return [...staged.keys()]
    },
    stage(epoch, slot, f) {
      if (epoch === LIVE) {
        throw new EpochError(
          'E_STAGE_LIVE',
          'the live epoch is what is painted; staging into it would defeat the point',
        )
      }
      let bucket = staged.get(epoch)
      if (!bucket) {
        if (staged.size >= maxOpen) {
          throw new EpochError(
            'E_TOO_MANY_EPOCHS',
            `${maxOpen} epochs are already open; commit or discard one first`,
          )
        }
        bucket = new Map()
        staged.set(epoch, bucket)
      }
      bucket.set(slot, { ...f, header: { ...f.header, s: slot, epoch } })
    },
    staged(epoch) {
      return [...(staged.get(epoch)?.values() ?? [])]
    },
    slots(epoch) {
      return [...(staged.get(epoch)?.keys() ?? [])]
    },
    commit(epoch, transition = 'view') {
      const bucket = staged.get(epoch)
      if (!bucket) throw new EpochError('E_NO_SUCH_EPOCH', `${epoch} has nothing staged`)
      const frames = [...bucket.values()]
      staged.delete(epoch)
      return [...frames, frame('COMMIT', { epoch, transition, slots: [...bucket.keys()].join(',') })]
    },
    discard(epoch) {
      const size = staged.get(epoch)?.size ?? 0
      staged.delete(epoch)
      return size
    },
  }
}
