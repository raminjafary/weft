import type { EnvelopeContext } from './context.ts'
import { PluginError, type Plugin } from './plugins.ts'

/**
 * Declared reads, enforced reads. Dev-only, so it is not in the request entry — wire it
 * explicitly: `createKernel({ guard: guardReads })`. See `spec/plan/plan.md`.
 */
export function guardReads(plugin: Plugin, ctx: EnvelopeContext): EnvelopeContext {
  const declared = new Set(plugin.reads ?? [])
  const check = (read: string): void => {
    if (!declared.has(read)) {
      throw new PluginError(
        'E_PLUGIN_UNDECLARED_READ',
        plugin.name,
        `read ${read} without declaring it. Add it to reads: [...]`,
      )
    }
  }
  return {
    ...ctx,
    flag: (name) => (check(`flag:${name}`), ctx.flag(name)),
    cookie: (key) => (check(`cookie:${key}`), ctx.cookie(key)),
    header: (key) => (check(`header:${key}`), ctx.header(key)),
    param: (key) => (check(`route:${key}`), ctx.param(key)),
    query: (key) => (check(`route:${key}`), ctx.query(key)),
    locale: () => (check('locale'), ctx.locale()),
    device: () => (check('device'), ctx.device()),
    user: () => (check('identity'), ctx.user()),
    now: () => (check('time'), ctx.now()),
  }
}
