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
    id: 'kernel-transport',
    label: 'Server kernel plus a live Warp channel',
    entry: kernelSrc('entry-transport.ts'),
    limit: 13 * 1024,
    limitNote: 'no design figure; ~970 B of room, which is what intents have to fit inside',
  },
  {
    id: 'channel-route',
    label: 'Channel route: an app route plus arriving frames',
    entry: src('entry-channel.ts'),
    limit: 4 * 1024,
    limitNote: 'no design figure; a watermark with ~470 B of room, so the next addition argues with a number',
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
