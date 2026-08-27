import { defineConfig } from '@weftjs/core'

/**
 * The inspector, as a deployment.
 *
 * It binds one flag axis because a station reads it, and nothing else: an in-process store, a
 * cookie session and `inline` as the only executor are what the stations are demonstrating
 * against. A station that needed more would be measuring a deployment rather than a mechanism.
 */
export default defineConfig({
  port: 4180,
  flags: { 'new-cart': ['off', 'on'] },
  nav: [
    { href: '/', label: 'Stations' },
    { href: '/spec', label: 'Coverage' },
  ],
})
