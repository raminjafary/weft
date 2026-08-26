import type { ClientTemplate, Resident } from './template.ts'

/** Where templates a client already holds are kept: IndexedDB, then memory, then nothing. */
export interface ResidentStore {
  all(): Promise<Resident>
  put(template: ClientTemplate): Promise<void>
  /** How the set is advertised to the server. Coarse on purpose. */
  digest(versions: string[]): string
  readonly durable: boolean
}

const DB = 'weft'
const STORE = 'templates'
const PREFIX = 8

/**
 * Where a resident template lives between visits. IndexedDB rather than a service worker,
 * because WKWebView gates service workers behind app-bound domains and in-app browsers
 * often suppress them entirely — the storage tier a repeat-visit claim rests on has to be
 * one that generic webviews actually have.
 *
 * When there is none, the store degrades to memory: correctness is unaffected and the
 * second visit simply pays what the first one did.
 */
export async function openResident(): Promise<ResidentStore> {
  const memory = new Map<string, ClientTemplate>()
  const fallback: ResidentStore = {
    durable: false,
    all: async () => Object.fromEntries(memory),
    put: async (template) => void memory.set(template.version, template),
    digest,
  }

  if (typeof indexedDB === 'undefined') return fallback

  let db: IDBDatabase
  try {
    db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB, 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE, { keyPath: 'version' })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('E_IDB_BLOCKED: another tab holds an older version'))
    })
  } catch {
    return fallback
  }

  return {
    durable: true,
    digest,
    all: () =>
      new Promise<Resident>((resolve, reject) => {
        const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
        request.onsuccess = () => {
          const out: Resident = {}
          for (const entry of request.result as ClientTemplate[]) out[entry.version] = entry
          resolve(out)
        }
        request.onerror = () => reject(request.error)
      }),
    put: (template) =>
      new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readwrite')
        transaction.objectStore(STORE).put(template)
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
      }),
  }
}

/**
 * A precise list of held template versions is an identifying surface, so only a prefix of
 * each is advertised. This is still not coarse enough for production — the design calls
 * for something probabilistic and bucketed — and the only cost of sending nothing at all
 * is that every visit is a first visit.
 */
export function digest(versions: string[]): string {
  return versions
    .map((version) => version.slice(0, PREFIX))
    .sort()
    .join(',')
}

/** The versions a `RESIDENT` digest says a client holds. Coarse on purpose: it is a fingerprint. */
export function heldBy(digestValue: string): Set<string> {
  return new Set(digestValue.split(',').filter(Boolean))
}

/** Whether that digest covers this version. */
export function isHeld(held: Set<string>, version: string): boolean {
  return held.has(version.slice(0, PREFIX))
}
