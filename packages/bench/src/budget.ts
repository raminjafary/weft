import { brotliCompressSync, constants, gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'

export interface ByteBudget {
  id: string
  label: string
  /** The entry to bundle, and what a route including it would actually pull in. */
  entry: string
  /** Compressed ceiling in bytes, from the design's stated budgets. */
  limit: number
  limitNote: string
}

export interface BundleSize {
  id: string
  label: string
  raw: number
  gzip: number
  brotli: number
  limit: number
  limitNote: string
  /** Measured against brotli, because that is what ships. */
  within: boolean
}

const src = (name: string) => fileURLToPath(new URL(`../../client/src/${name}`, import.meta.url))
const front = (name: string) => fileURLToPath(new URL(`../../weft/src/client/${name}`, import.meta.url))
const kernelSrc = (name: string) => fileURLToPath(new URL(`../../kernel/src/${name}`, import.meta.url))

export const BUDGETS: ByteBudget[] = [
  {
    id: 'runtime',
    label: 'Client runtime, everything',
    entry: src('index.ts'),
    limit: 6 * 1024,
    limitNote: '4-6 KB for the client runtime',
  },
  {
    id: 'content-route',
    label: 'Content route: adopt and bind, no updates',
    entry: src('entry-content.ts'),
    limit: 5 * 1024,
    limitNote: '<5 KB for a content route, including the runtime',
  },
  {
    id: 'kernel',
    label: 'Server kernel: the document request path',
    entry: kernelSrc('entry-request.ts'),
    limit: 8 * 1024,
    limitNote: 'under 8 KB server-side',
  },
  {
    id: 'kernel-refresh',
    label: 'Server kernel plus surgical refresh and epochs',
    entry: kernelSrc('entry-channel.ts'),
    limit: 12 * 1024,
    limitNote: 'no design figure; measured so a regression is visible',
  },
  {
    id: 'kernel-patch',
    label: 'Server kernel plus the surgical rung that needs no projectable values',
    entry: kernelSrc('entry-patch.ts'),
    limit: 12 * 1024,
    limitNote:
      'no design figure; its own entry, because written into the refresh path the encoder took four other watermarks past their ceilings',
  },
  {
    id: 'kernel-intent',
    label: 'Server kernel plus intent dispatch',
    entry: kernelSrc('entry-intent.ts'),
    limit: 10 * 1024,
    limitNote: 'no design figure; its own entry, because the request path has no room for a new capability',
  },
  {
    id: 'kernel-transport',
    label: 'Server kernel plus a live Warp channel',
    entry: kernelSrc('entry-transport.ts'),
    limit: 14 * 1024,
    limitNote:
      'no design figure; moved from 13 KB when the surgical ladder grew its second rung — the choice is in the refresh path even where the encoder is not. See spec/kernel/budgets.md',
  },
  {
    id: 'kernel-stage',
    label: 'Server kernel plus a route staged over the channel',
    entry: kernelSrc('entry-stage.ts'),
    limit: 14 * 1024,
    limitNote: 'no design figure; its own entry, because it went 108 B past the transport watermark',
  },
  {
    id: 'kernel-authority',
    label: 'Server kernel plus a capability model and signed intents',
    entry: kernelSrc('entry-authority.ts'),
    limit: 12 * 1024,
    limitNote:
      'no design figure; its own entry, because the design calls the authority tier separable and a tier that is separable is a tier you can measure',
  },
  {
    id: 'kernel-discover',
    label: 'Server kernel plus lazy plan extension',
    entry: kernelSrc('entry-discover.ts'),
    limit: 15 * 1024,
    limitNote: 'no design figure; its own entry, on the same rule route staging established',
  },
  {
    id: 'kernel-render',
    label: 'Server kernel plus a catalogue of fragments a client can ask for by opaque id',
    entry: kernelSrc('entry-render.ts'),
    limit: 14 * 1024,
    limitNote:
      'no design figure; its own entry, because a deployment whose clients cannot name a renderable should not carry the dispatch',
  },
  {
    id: 'kernel-region',
    label: 'Server kernel plus a page composed out of regions on other deployments',
    entry: kernelSrc('entry-region.ts'),
    limit: 12 * 1024,
    limitNote:
      'no design figure; its own entry, because a deployment that composes nothing should not carry the check that makes composing safe. Moved from 11 KB, which had 18 B of headroom, when the ladder grew a rung',
  },
  {
    id: 'kernel-region-channel',
    label: 'Server kernel plus a region on another deployment, refreshed over a live channel',
    entry: kernelSrc('entry-region-channel.ts'),
    limit: 17 * 1024,
    limitNote:
      'no design figure; its own entry, because neither the transport nor composition alone covers it. Moved from 16 KB with the transport watermark, and for the same reason',
  },
  {
    id: 'discover-route',
    label: 'Navigation plus what the client knows about routes it has not been to',
    entry: src('entry-discover.ts'),
    limit: 6 * 1024,
    limitNote: 'no design figure; a watermark over a capability whose whole point is a request it saves',
  },
  {
    id: 'channel-route',
    label: 'Channel route: an app route plus arriving frames',
    entry: src('entry-channel.ts'),
    limit: 4 * 1024,
    limitNote: 'no design figure; a watermark with ~470 B of room, so the next addition argues with a number',
  },
  {
    id: 'expose-route',
    label: 'Channel route plus a shell signal reaching a region on this page',
    entry: src('entry-expose.ts'),
    limit: 5 * 1024,
    limitNote:
      'no design figure; its own entry, because a page that composes no region should not carry the exposed table',
  },
  {
    id: 'patch-route',
    label: 'Channel route plus the ladder rung that needs no resident template',
    entry: src('entry-patch.ts'),
    limit: 5 * 1024,
    limitNote:
      'no design figure; its own entry, because a page whose regions are all projectable never receives a PATCH',
  },
  {
    id: 'nav-route',
    label: 'Channel route plus instant navigation',
    entry: src('entry-nav.ts'),
    limit: 5 * 1024,
    limitNote:
      'no design figure; its own entry, because a page that links nowhere should not pay for staging',
  },
  {
    /**
     * The front door's own code, bundled — and **not** what a page downloads.
     *
     * This entry claimed to be the download figure and it was wrong by 3.6×. It bundles with
     * Rolldown and minifies, and this framework has no bundler and no minifier: a page fetches the
     * boot module and every module it imports as separate responses, served as written with their
     * types stripped and their comments intact. Walking that graph and compressing each response
     * the way it arrives gives **44,716 B** for the demo against the 13,033 B below.
     *
     * The entry stays, because a gate on how much code there *is* is worth having and this is a
     * good one — minified bytes are a proxy for logic that comments and formatting do not move. It
     * stops claiming to be the number a reader on a phone pays. That number is measured by
     * `measureClientJs` in `@weft/weft`, gated by `budget({ js, grow })`, and reported by
     * `weft build`.
     */
    id: 'front-door',
    label: 'The front door’s code, bundled and minified — not what a page downloads',
    entry: front('boot.ts'),
    limit: 13 * 1024,
    limitNote:
      'no design figure; a watermark over how much code the front door is. Moved from 12 KB when the exposed table landed — see spec/kernel/budgets.md',
  },
  {
    id: 'app-route',
    label: 'App route: adopt, bind, patch, persist',
    entry: src('entry-app.ts'),
    limit: 12 * 1024,
    limitNote: '<12 KB for an app route before first interaction',
  },
]

/**
 * Bundles each entry the way production would and measures it compressed. A budget is a
 * gate, not a report: the test that calls this fails the build when an entry grows past
 * its ceiling, which is the only way a byte budget survives contact with a feature.
 */
export async function measureBudgets(budgets = BUDGETS): Promise<BundleSize[]> {
  const out: BundleSize[] = []

  for (const budget of budgets) {
    const build = await rolldown({
      input: budget.entry,
      platform: budget.id.startsWith('kernel') ? 'neutral' : 'browser',
      resolve: { extensions: ['.ts', '.js'] },
    })
    const { output } = await build.generate({ format: 'esm', minify: true })
    await build.close()

    const code = output
      .filter((chunk) => chunk.type === 'chunk')
      .map((chunk) => (chunk as { code: string }).code)
      .join('\n')
    const bytes = Buffer.from(code, 'utf8')

    const brotli = brotliCompressSync(bytes, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
      },
    }).length

    out.push({
      id: budget.id,
      label: budget.label,
      raw: bytes.length,
      gzip: gzipSync(bytes, { level: 9 }).length,
      brotli,
      limit: budget.limit,
      limitNote: budget.limitNote,
      within: brotli <= budget.limit,
    })
  }

  return out
}
