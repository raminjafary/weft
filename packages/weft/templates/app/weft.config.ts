import { defineConfig } from '@weft/core'

/**
 * What this deployment binds. Everything is optional, and an application with no config file gets
 * an in-process store, a cookie session, no flag axes and `inline` as the only executor — which
 * is a real single-process deployment rather than a placeholder.
 *
 * The moment you bind a port here, nothing else in the application changes.
 */
export default defineConfig({
  // port: 3000,
  // A flag axis has to be declared before it can be read, so a typo is a build error rather than
  // a branch that silently never runs.
  // flags: { 'new-checkout': ['off', 'on'] },
  // store: redisStore({ url: process.env.REDIS_URL }),
})
