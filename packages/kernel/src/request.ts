/**
 * The request lifecycle, as a state machine rather than a convention.
 *
 * Every framework has these phases; almost none of them name the transitions, which is why
 * "you cannot set a cookie there" is documentation instead of a type error. Here the
 * machine is the thing that refuses, and every refusal is a named code.
 */
export type RequestState =
  /** Nothing has run. Early Hints may go out from here. */
  | 'received'
  /** Phase A. Filters, guards, envelope effects. The envelope is open. */
  | 'envelope'
  /** The envelope is sealed: status and headers are frozen and the plan is resolved. */
  | 'planned'
  /** Phase B. Slots render. `ctx` here has no envelope methods at all. */
  | 'streaming'
  /** The body is closed. Deferred envelope effects, if any, are now owed to a later request. */
  | 'settled'
  | 'failed'

const NEXT: Record<RequestState, readonly RequestState[]> = {
  received: ['envelope', 'failed'],
  envelope: ['planned', 'settled', 'failed'],
  planned: ['streaming', 'settled', 'failed'],
  streaming: ['settled', 'failed'],
  settled: [],
  failed: [],
}

/** A transition the state machine does not have: `E_REQUEST_STATE`, naming both states. */
export class LifecycleError extends Error {
  code: string
  state: RequestState

  constructor(code: string, state: RequestState, message: string) {
    super(`${code} in state ${state} — ${message}`)
    this.name = 'LifecycleError'
    this.code = code
    this.state = state
  }
}

/** The request as a state machine, with declared transitions and nothing else permitted. */
export interface Lifecycle {
  readonly state: RequestState
  readonly log: readonly RequestState[]
  to(next: RequestState): void
  /** Throws unless the machine is in one of these states. The only guard anything else uses. */
  mustBe(states: readonly RequestState[], what: string, code: string): void
  is(state: RequestState): boolean
}

/** One request's lifecycle, which is also the log of what it did. */
export function lifecycle(): Lifecycle {
  let state: RequestState = 'received'
  const log: RequestState[] = ['received']

  return {
    get state() {
      return state
    },
    get log() {
      return log
    },
    is: (s) => state === s,
    to(next) {
      if (!NEXT[state].includes(next)) {
        throw new LifecycleError('E_REQUEST_STATE', state, `cannot move to ${next}`)
      }
      state = next
      log.push(next)
    },
    mustBe(states, what, code) {
      if (!states.includes(state)) {
        throw new LifecycleError(code, state, `${what} is legal only in ${states.join(' or ')}`)
      }
    },
  }
}
