import type { EnvelopeContext } from './context.ts'
import { PluginError, type Plugin } from './plugins.ts'

/**
 * Declared reads, enforced reads. A plugin that touches request state it did not declare
 * throws rather than quietly tainting nothing, because the effect graph has to stay honest.
 *
 * Dev-only, which is what the design specifies, and therefore not in the request entry: a
 * production request should not build a nine-method proxy per plugin to catch a mistake that
 * fails on the first dev run. Wire it explicitly — `createKernel({ guard: guardReads })` —
 * and the check is on in exactly the builds that want it.
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
