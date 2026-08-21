/**
 * Intent references, imported by a fragment so the compiler can derive a stable, opaque id from
 * this module and export name.
 *
 * The bodies are never called on the client and never shipped to it: `onInput={setQuantity}` lowers
 * to a wiring entry naming an id, so the client carries six hex characters where another framework
 * would carry a closure. Renaming this file changes the id, deliberately — moving an intent is a
 * wire change and the design says so.
 */
export function setQuantity(): void {
  throw new Error('E_SERVER_ONLY: an intent body runs on the server, through the registry')
}

export function addToCart(): void {
  throw new Error('E_SERVER_ONLY: an intent body runs on the server, through the registry')
}
