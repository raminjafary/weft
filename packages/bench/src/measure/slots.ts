import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { compileFiles } from '../../../compiler/src/index.ts'
import type { TemplateIR } from '../../../ir/src/index.ts'
import { serveRoute } from '../../../adapters/src/node-serve.ts'
import type { Order, Route } from '../../../kernel/src/index.ts'
import { loadPlaywright, type EngineName } from './browser.ts'

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const FIXTURE = 'packages/compiler/fixtures/slots.tsx'

/** The slow region is first in document order, which is the only arrangement that separates the two orders. */
export const DELAYS = { feed: 80, recs: 20 }

const CONTENT = {
  feed: '<article class="feed">feed ready</article>',
  recs: '<article class="recs">recs ready</article>',
}

const PRELUDE = `<!doctype html><html><head><meta charset="utf-8"><title>slots</title><script>
window.__t={};(function(){var n=['feed','recs'];function c(){for(var i=0;i<n.length;i++){var k=n[i];if(window.__t[k])continue;var e=document.getElementById(k);if(e&&e.textContent.trim().length)window.__t[k]=performance.now()}}
new MutationObserver(c).observe(document.documentElement,{childList:true,subtree:true,characterData:true});
window.__done=function(){c();return window.__t}})();
</script></head><body>`

const POSTLUDE = '</body></html>'

export interface RegionTimes {
  feed: number
  recs: number
}

export interface SlotRun {
  engine: EngineName
  engineVersion: string
  inOrder: RegionTimes[]
  outOfOrder: RegionTimes[]
  /** Whether both orders end at the same DOM, which is the only correctness that matters. */
  sameDom: boolean
  domDetail?: string
}

async function template(): Promise<TemplateIR> {
  const { modules } = await compileFiles([FIXTURE], { root: ROOT })
  const entry = modules[0]?.fragments[0]?.entry
  if (!entry) throw new Error(`E_NO_FRAGMENT: ${FIXTURE}`)
  return entry
}

function route(ir: TemplateIR): Route {
  return {
    template: ir,
    values: { title: 'Slots', feed: '', recs: '' },
    slots: {
      feed: () => delay(DELAYS.feed, CONTENT.feed),
      recs: () => delay(DELAYS.recs, CONTENT.recs),
    },
  }
}

function delay(ms: number, value: string): Promise<string> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

async function visit(
  pw: NonNullable<Awaited<ReturnType<typeof loadPlaywright>>>,
  engine: EngineName,
  url: string,
  iterations: number,
) {
  const browser = await pw[engine].launch()
  try {
    const times: RegionTimes[] = []
    let markup = ''
    for (let i = 0; i < iterations; i++) {
      const context = await browser.newContext()
      const tab = await context.newPage()
      await tab.goto(url, { waitUntil: 'load' })
      times.push(await tab.evaluate<RegionTimes>('(() => window.__done())()'))
      if (i === 0) {
        // The anchor comment is left in the DOM on purpose, so it is not part of the
        // comparison: a hole that keeps its anchor can be filled again by a later refresh.
        markup = await tab.evaluate<string>(
          `(() => ['feed','recs'].map((n) => document.getElementById(n).innerHTML.replace(/<!--[\\s\\S]*?-->/g, '').trim()).join('|'))()`,
        )
      }
      await tab.close()
      await context.close()
    }
    return { times, markup, version: browser.version() }
  } finally {
    await browser.close()
  }
}

/**
 * Streams the same route twice, once in document order and once fastest-first, and records
 * when each region actually appears. The slow region is first, so in-order has to hold the
 * fast one behind it and out-of-order does not.
 */
export async function measureSlots(engine: EngineName, iterations = 5): Promise<SlotRun> {
  const pw = await loadPlaywright()
  if (!pw) throw new Error('E_NO_PLAYWRIGHT: install playwright to measure slot streaming')

  const ir = await template()
  const results: Record<Order, { times: RegionTimes[]; markup: string; version: string }> = {} as never

  for (const order of ['in-order', 'out-of-order'] as Order[]) {
    const serving = await serveRoute(route(ir), { order, prelude: PRELUDE, postlude: POSTLUDE })
    try {
      results[order] = await visit(pw, engine, serving.url, iterations)
    } finally {
      await serving.close()
    }
  }

  const a = results['in-order']
  const b = results['out-of-order']
  const same = a.markup === b.markup
  return {
    engine,
    engineVersion: a.version,
    inOrder: a.times,
    outOfOrder: b.times,
    sameDom: same,
    ...(same ? {} : { domDetail: `in-order ${a.markup} :: out-of-order ${b.markup}` }),
  }
}

export interface DsdProbe {
  engine: EngineName
  /** When the shadow root existed, against a region that only closes at 60 ms. */
  shadowRootMs: number | null
  slottedMs: number | null
  renderedBeforeClose: boolean
  closedMs: number
}

/**
 * The platform risk the design calls its largest: declarative shadow DOM is Baseline, but
 * attaching the shadow root *while the host is still streaming* is tracked separately and
 * may differ by engine. If it does not work, zero-JavaScript hole filling is not available
 * and the inline filler is the primary path rather than a fallback.
 */
export async function probeIncrementalDsd(engine: EngineName): Promise<DsdProbe> {
  const pw = await loadPlaywright()
  if (!pw) throw new Error('E_NO_PLAYWRIGHT: install playwright to probe declarative shadow DOM')

  const head = `<!doctype html><html><head><meta charset="utf-8"><script>
window.__p={shadow:null,slotted:null,rendered:false};
setInterval(function(){var h=document.getElementById('host');if(!h)return;
if(window.__p.shadow===null&&h.shadowRoot)window.__p.shadow=performance.now();
var s=h.querySelector('[slot="x"]');if(s&&window.__p.slotted===null){window.__p.slotted=performance.now();window.__p.rendered=s.getClientRects().length>0}},2);
</script></head><body>`

  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.write(`${head}<section id="host"><template shadowrootmode="open"><slot name="x"></slot></template>`)
    setTimeout(() => {
      res.end('<div slot="x">filled</div></section></body></html>')
    }, 60)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address === 'string' || address === null) throw new Error('E_NO_ADDRESS')

  const browser = await pw[engine].launch()
  try {
    const context = await browser.newContext()
    const tab = await context.newPage()
    await tab.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'load' })
    const probe = await tab.evaluate<{
      shadow: number | null
      slotted: number | null
      rendered: boolean
      closed: number
    }>(`(() => ({ ...window.__p, closed: performance.now() }))()`)
    await tab.close()
    await context.close()
    return {
      engine,
      shadowRootMs: probe.shadow,
      slottedMs: probe.slotted,
      renderedBeforeClose: probe.rendered,
      closedMs: probe.closed,
    }
  } finally {
    await browser.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
