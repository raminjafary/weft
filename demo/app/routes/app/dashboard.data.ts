import { defineRoute } from '@weft/core'
import { dashPanel } from '../../lib/data.ts'
import type { ExceedPolicy } from '@weft/core'
import { field, panel, pick, press, slider } from '../../lib/controls.ts'

/** What a control is read through. A control on a server-rendered page is a query parameter. */
interface Controls {
  query(key: string): string | undefined
}

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

/** What the plan declares. A control may override the first two per request; the plan keeps these. */
const SLOW_MS = 600
const CPU_BUDGET_MS = 200
const ON_EXCEED: ExceedPolicy = 'placeholder'
const EXCEED_POLICIES: ExceedPolicy[] = ['placeholder', 'stale', 'fallback', 'client', 'fail']

const num = (ctx: Controls, key: string, fallback: number): number => {
  const value = Number(ctx.query(key) ?? fallback)
  return Number.isFinite(value) ? value : fallback
}

/**
 * The panel, as a function of the request.
 *
 * A slider that does not render at the value in the URL snaps back to its default on every reload,
 * which makes it look like the control did nothing. The control *is* the query parameter, so the
 * markup has to read it.
 */
const PANEL = (ctx: Controls): string =>
  panel(
    [
      field('slowest panel (ms)', slider('dash-slow', 0, 1500, num(ctx, 'slow', SLOW_MS), 50)),
      field('cpu budget (ms)', slider('dash-budget', 20, 800, num(ctx, 'budget', CPU_BUDGET_MS), 20)),
      field('on exceed', pick('dash-exceed', EXCEED_POLICIES, exceedOf(ctx))),
      press('dash-reload', 'reload with these'),
    ].join(''),
    'The slowest panel needs the traffic panel, so it cannot start until that one lands. Its budget and ' +
      'exceed policy are plan declarations — the plan still holds ' +
      `<code>${CPU_BUDGET_MS} ms</code> / <code>${ON_EXCEED}</code>, which is what <code>weft why</code> ` +
      'and the build report show. These two controls override them for this request, which is the only ' +
      'reason a page can let you watch what a policy does. On <code>inline</code> a CPU budget is ' +
      'advisory, so what you are watching is the policy rather than a preemption.',
  )

/** The exceed policy asked for, or the declared one. An unknown name is not honoured. */
function exceedOf(ctx: Controls): ExceedPolicy {
  const asked = ctx.query('exceed')
  return EXCEED_POLICIES.includes(asked as ExceedPolicy) ? (asked as ExceedPolicy) : ON_EXCEED
}

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
    panel: { fragment: 'markup', stream: false, html: (ctx) => PANEL(ctx) },
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
      budget: { cpu: `${CPU_BUDGET_MS}ms`, onExceed: ON_EXCEED },
      // The same two values, for this request. The plan keeps the declaration above.
      budgetFor: ({ query }) => ({
        cpu: `${Number(query.get('budget') ?? CPU_BUDGET_MS)}ms`,
        onExceed: exceedOf({ query: (key) => query.get(key) ?? undefined }),
      }),
      placeholder: '<div class="dash-panel"><p class="skeleton">over budget</p></div>',
      load: async (ctx) => {
        const ms = num(ctx, 'slow', SLOW_MS)
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
