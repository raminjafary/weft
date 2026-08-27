import { render, type Values } from '@weft/ir'
import { createEnvelope, createReads, lifecycle, renderContext, requestFacts, type Ports } from '@weft/kernel'
import { cookieSession, memoryStore, staticFlags } from '@weft/adapters'
import { staticVerdict } from '@weft/core/server'
import { fragmentIR, type RenderContext } from '@weft/core'
import { field, panel, pick, pre, press, readout } from '../pages.ts'
import type { StationHandler } from './kind.ts'

/**
 * L0: the tier where the answer is a file and the kernel is not involved.
 *
 * The station shows the two halves of the decision separately, because the interesting thing
 * about this feature is that either half alone gets it wrong.
 *
 * The **classifier** runs over this repository's own fixture fragments. It is the real
 * `staticVerdict` — the one `weft build` calls — reading the real effect sets the compiler
 * inferred, so the table below is not a description of the rule, it is the rule.
 *
 * The **probe** is the half the effect set cannot do. A route's loader lives in a `.data.ts`,
 * which nothing compiles, so a read in there is invisible: the page is classified `static` and is
 * not. Pick a loader here and watch a page that every static analysis calls invariant come out
 * different under two requests.
 */
const ports = (): Ports => ({
  store: memoryStore(),
  session: cookieSession({ cookie: 'sid' }),
  flags: staticFlags({ axes: { 'new-cart': ['off', 'on'] } }),
  executors: {},
})

/** The same fixtures the effects station uses, so a reader can move between the two pages. */
const FRAGMENTS = ['static', 'clock', 'private', 'identity', 'composed'] as const

const LOADERS = ['none', 'a cookie', 'the clock', 'throws'] as const

type LoaderChoice = (typeof LOADERS)[number]

function loaderFor(choice: LoaderChoice): (ctx: RenderContext) => Promise<Values> {
  if (choice === 'a cookie') {
    return async (ctx) => ({ html: `<p>theme: ${ctx.cookie('theme') ?? 'none'}</p>` }) as unknown as Values
  }
  if (choice === 'the clock') {
    return async (ctx) => ({ html: `<p>rendered at ${ctx.now()}</p>` }) as unknown as Values
  }
  if (choice === 'throws') {
    return async () => {
      throw new Error('this loader cannot run')
    }
  }
  return async () => ({ html: '<p>the same bytes for everybody</p>' }) as unknown as Values
}

interface ProbeResult {
  html: string
  taints: string[]
  failed?: string
}

/**
 * One render, under one request.
 *
 * Everything the build's probe varies, this varies two of: the cookie header and the clock. It is
 * the same idea at a size that fits on a page — and the readout says so rather than implying the
 * page runs the whole thing.
 */
async function probe(
  loader: (ctx: RenderContext) => Promise<Values>,
  headers: Record<string, string>,
  clock: number,
): Promise<ProbeResult> {
  const markup = fragmentIR('markup')
  const reads = createReads(
    requestFacts(new Request('http://weft.local/s/static-documents', { headers })),
    ports(),
    { clock: () => clock },
  )
  const ctx = renderContext(reads, createEnvelope(lifecycle()))
  try {
    const values = await loader(ctx)
    return {
      html: new TextDecoder().decode(render(markup.entry, values, markup.resolve)),
      taints: reads.taints(),
    }
  } catch (error) {
    return { html: '', taints: reads.taints(), failed: (error as Error).message }
  }
}

const BUILD_CLOCK = 1_700_000_000_000
const LATER = BUILD_CLOCK + 10 * 365 * 24 * 60 * 60 * 1000

export const staticDocuments: StationHandler = async (ctx) => {
  const choice = (LOADERS.find((l) => l === ctx.query('loader')) ?? 'none') as LoaderChoice
  const loader = loaderFor(choice)

  const layout = fragmentIR('layout')
  const structural = FRAGMENTS.map((name) => {
    const fragment = fragmentIR(`fragment:${name}`)
    const verdict = staticVerdict({
      pattern: '/a-page',
      module: {},
      shell: layout,
      slots: [{ name: 'body', fragment, declaration: { stream: false }, streams: false }],
    })
    return { name, file: fragment.file, verdict }
  })

  return {
    panel: panel(
      [field('loader', pick('l0-loader', [...LOADERS], choice)), press('l0-go', 'probe it')].join(''),
      'A loader is a function in a .data.ts. Nothing compiles it, so nothing above knows what it reads — which is why the build renders the page twice instead of trusting the classifier.',
    ),

    body: async () => {
      const plain = await probe(loader, {}, BUILD_CLOCK)
      const hostile = await probe(loader, { cookie: 'theme=dark' }, LATER)
      const failed = plain.failed ?? hostile.failed
      const identical = !failed && plain.html === hostile.html

      const verdict = failed ? 'L0_DEGRADED' : identical ? 'a file' : 'L0_VARIES'
      return readout(
        `a page whose loader reads ${choice}`,
        [
          {
            label: 'Structurally',
            value: 'static',
            note: 'every fragment on this page reads nothing, so nothing the compiler can see refuses it',
          },
          {
            label: 'Bare request',
            value: failed ? `failed: ${plain.failed ?? ''}` : `${plain.html.length} B`,
            note: plain.html || 'nothing rendered',
          },
          {
            label: 'Cookie, and a clock ten years on',
            value: failed ? `failed: ${hostile.failed ?? ''}` : `${hostile.html.length} B`,
            note: hostile.html || 'nothing rendered',
          },
          {
            label: 'What the render read',
            value: plain.taints.length ? plain.taints.join(', ') : 'nothing through ctx',
            note: 'a read the framework mediates is visible here. One made behind its back is not, and is the case the probe can only catch when it reaches the bytes',
          },
          {
            label: 'Verdict',
            value: verdict,
            state: verdict === 'a file' ? ('within' as const) : ('over' as const),
            note:
              verdict === 'a file'
                ? 'weft build would write this document to .weft/static and weft start would answer with it before reaching the kernel'
                : verdict === 'L0_VARIES'
                  ? 'the two renders differ, so no single file can answer this URL'
                  : 'it degraded to a placeholder, and a placeholder frozen into a file is a failure that stops looking like one',
          },
        ],
        {
          what: 'The same two-render probe weft build runs, at a size that fits on a page.',
          from: 'prerender() in packages/weft/src/static.ts, called by weft build',
          caveat:
            'The build varies seven axes — cookies, locale, device, an arbitrary header, the query string, every flag, and the clock. This varies two of them.',
          tryThis: 'Switch the loader. Only the first one is a document that can be a file.',
        },
      )
    },

    readout: async () =>
      `<div class="card"><h3>The classifier, over this repository's own fragments</h3>
      <p class="hint">A page whose body is each of these, and what <code>staticVerdict</code> says
      about it. The read sets are the compiler's.</p>
      ${pre(
        structural
          .map(
            ({ name, file, verdict }) =>
              `${name.padEnd(10)} ${verdict.static ? 'static'.padEnd(16) : verdict.code.padEnd(16)} ${
                verdict.static ? file : verdict.reason
              }`,
          )
          .join('\n'),
      )}</div>`,
  }
}
