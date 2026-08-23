import { unimplemented, type DbQuery, type Ports, type RenderContext } from '@weft/kernel'

/**
 * What a route's own code may reach that is not a read of the request.
 *
 * Everything on the kernel's context taints: it is a property of the request, so it lands in the
 * cache key. These two are properties of the *deployment*. A setting is the same for every request
 * the process serves, and a query says where the data came from rather than which data was asked
 * for — so neither may taint, and a setting that did would put a database URL in a key nobody
 * could safely log.
 *
 * They live here rather than in the kernel for a reason the byte budget made unarguable. A loader
 * is a front-door concept — a `.data.ts` the compiler never reads — and the kernel's document
 * request path has 134 bytes of headroom against a figure the design fixed. A new capability does
 * not draw on that headroom; it goes where its consumer already is, which is here.
 *
 * Both refuse by name when their port is unbound. Returning `undefined` for a setting nobody
 * configured would turn a deployment mistake into a rendering one three files away.
 */
export interface Services {
  setting(key: string): string | undefined
  /** A setting the deployment cannot run without. Missing is refused, never defaulted. */
  required(key: string): string
  data<T>(query: DbQuery, run: (signal: AbortSignal) => Promise<T>): Promise<T>
}

/** What a route's loader receives: the kernel's reads, plus what the deployment bound. */
export type LoaderContext = RenderContext & Services

export function services(ports: Ports): Services {
  return {
    setting: (key) => (ports.config ? ports.config.get(key) : unimplemented('config')),
    required: (key) => (ports.config ? ports.config.required(key) : unimplemented('config')),
    data: (query, run) => (ports.db ? ports.db.query(query, run) : unimplemented('db')),
  }
}

/**
 * The kernel's context, with the deployment's services on it.
 *
 * Wrapped rather than replaced: what the kernel handed in is what tracks reads and what the cache
 * key comes from, and nothing here can add to it. That is the property worth keeping — a loader
 * gains a database and a settings table and still cannot smuggle an unkeyed read into a render.
 */
export function withServices(ctx: RenderContext, ports: Ports): LoaderContext {
  return { ...ctx, ...services(ports) }
}
