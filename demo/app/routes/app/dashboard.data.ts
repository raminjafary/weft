import { defineRoute } from 'weft'
import { dashPanel } from '../../../src/data.ts'
import { field, panel, pick, press, slider } from '../../../src/pages.ts'

/**
 * A dashboard with slow panels, and the one route in the demo that needs a different document.
 *
 * `layout: 'dash'` picks `app/layouts/dash.tsx`, whose slot holes are four panels rather than one
 * body. The plan is generated per route, so nothing else in the application has to know that this
 * page has a different shape.
 *
 * `slowest` needs `traffic`, so the scheduler puts it in a later wave: watch the waves, not the
 * sum. Its budget is advisory and says so — the demo binds no pool, so `inline` is the only
 * executor there is.
 */
const slow = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()

const PANEL = panel(
  [
    field('slowest panel (ms)', slider('dash-slow', 0, 1500, 600, 50)),
    field('cpu budget (ms)', slider('dash-budget', 20, 800, 200, 20)),
    field('on exceed', pick('dash-exceed', ['placeholder', 'stale', 'fallback', 'client', 'fail'])),
    press('dash-reload', 'reload with these'),
  ].join(''),
  'The slowest panel needs the traffic panel, so it cannot start until that one lands.',
)

const SKELETON = '<div class="dash-panel"><p class="skeleton"></p></div>'

const fixed = (title: string, ms: number, policy: string, series: number) => async () => {
  await slow(ms)
  return dashPanel(title, ms, 'inline', policy, series)
}

export default defineRoute({
  layout: 'dash',
  head: { title: 'A dashboard with slow panels · weft demo' },
  layoutValues: { heading: 'A dashboard with slow panels' },
  slots: {
    panel: { fragment: 'markup', stream: false, html: PANEL },
    traffic: {
      fragment: 'dashboard',
      stream: { prio: 3 },
      cache: { class: 'public', ttl: '60s' },
      placeholder: SKELETON,
      load: fixed('Traffic', 40, 'public', 11),
    },
    revenue: {
      fragment: 'dashboard',
      stream: { prio: 2 },
      cache: { class: 'public', ttl: '60s' },
      placeholder: SKELETON,
      load: fixed('Revenue', 120, 'public', 23),
    },
    errors: {
      fragment: 'dashboard',
      stream: { prio: 2 },
      cache: { class: 'public', ttl: '60s' },
      placeholder: SKELETON,
      load: fixed('Errors', 80, 'public', 31),
    },
    slowest: {
      fragment: 'dashboard',
      stream: { prio: 1 },
      needs: ['traffic'],
      budget: { cpu: '200ms', onExceed: 'placeholder' },
      placeholder: '<div class="dash-panel"><p class="skeleton">over budget</p></div>',
      load: async (ctx) => {
        const ms = Number(ctx.query('slow') ?? 600)
        await slow(ms)
        return dashPanel('Cohort retention', ms, 'inline', 'uncached', 47)
      },
    },
    readout: {
      fragment: 'markup',
      stream: false,
      html: '<div class="card" id="dash-readout"><h3>Waves</h3><p class="hint">The slowest panel waits for traffic. Reload and watch the order.</p></div>',
    },
  },
})
