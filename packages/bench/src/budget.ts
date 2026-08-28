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
    /**
     * Moved from 8,192 — the design's "target under 8 KB server-side" — to 8,320.
     *
     * This is the only ceiling here that came from a design figure rather than a watermark, and
     * `spec/FINDINGS.md` says a third redrawing should be treated as a rationalisation. So the
     * argument is written down rather than assumed.
     *
     * What spent it: `cond` in the derived-expression union, which is what lets a template hold
     * `a ? b : c` and the `??` and `||` the compiler lowers to it. 14 B against 7 B of headroom, and
     * the whole of it is one arm in `evalDerived` — five encodings were measured (a coalesce flag, a
     * separate concat node, an operator lookup table, hoisting the shared operand, selecting the
     * node rather than the arms) and every one came out larger than the plain form.
     *
     * Why it was worth redrawing: without it a fragment cannot express a conditional value at all,
     * so every one becomes a string concatenated in a loader — which is the state the documentation
     * site was in, and the reason it had 476 lines of markup outside the compiler's sight.
     *
     * The design figure said *target*, and 8,320 B is 8.125 KB. That is a real move and not a
     * rounding, which is why the number here is not 8 KB any more and this comment exists.
     */
    limit: 8320,
    limitNote: 'the design\'s "target under 8 KB server-side", moved from 8,192 for conditional values',
  },
  {
    id: 'kernel-nested',
    label: 'Server kernel plus a document made of nested layouts',
    entry: kernelSrc('entry-nested.ts'),
    limit: 9 * 1024,
    limitNote:
      'no design figure; its own entry, because a chain walk written into splitAtSlots cost 83 B and the 8 KB path had 74 B left',
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
    id: 'kernel-journal',
    label: 'Server kernel plus somewhere an invalidation waits for a client that is not connected',
    entry: kernelSrc('entry-journal.ts'),
    limit: 15 * 1024,
    limitNote:
      'no design figure; its own entry, because a deployment whose every binding holds a connection has nothing to write down — and because the hub takes a hook rather than the port, so nothing else would have measured it',
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
    /**
     * Moved from 14,336 to 14,592, in two steps and for two capabilities.
     *
     * 14,336 → 14,464 for `cond` (conditional values); → 14,592 for a row naming its position or
     * interpolating its item. Both are watermarks moving under a capability, which is the rule this
     * table already applies to `entry-transport`, `entry-region` and `entry-region-channel`.
     *
     * The second step is deliberately larger than the 2 B that forced it. Bumping a watermark by the
     * exact overage makes the next commit do it again, which turns a gate into a ritual; ~126 B of
     * room means the next addition here argues with a number instead.
     */
    limit: 14592,
    limitNote:
      'no design figure; its own entry, because a deployment whose clients cannot name a renderable should not carry the dispatch. Moved from 14,336 via 14,464',
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
    /**
     * Raised from 4 KB, which is the argument the previous note asked the next addition to make.
     *
     * What spent it: `cond` in the derived-expression union, so a template may hold `a ? b : c` and
     * the `??` and `||` the compiler lowers to it. Measured at 4121 B against the old 4096 — 25 B,
     * for value-level branching evaluated identically on both sides.
     *
     * It was 108 B before three passes at the encoding: the coalesce flag went (the compiler emits a
     * `!== null` test instead), the `cat` node went (a template literal lowers to a `+` chain, and
     * `+` on a string already concatenates), the operands became `a`/`b`/`c` so the evaluator lines
     * are byte-identical to the binary case, and `reaches` became structural rather than a case per
     * kind. The remaining 25 B is the `cond` arm itself.
     *
     * Still a watermark rather than a design figure, and still tight on purpose: ~380 B of room.
     */
    limit: 4608,
    limitNote: 'no design figure; a watermark with ~380 B of room, so the next addition argues with a number',
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
     * types stripped. Walking that graph and compressing each response the way it arrives gives
     * **25,835 B** for the demo against the 14,031 B below — it was 44,716 against 13,033 when this
     * was written, and closed to under 2× when a production build stopped shipping its comments.
     *
     * The entry stays, because a gate on how much code there *is* is worth having and this is a
     * good one — minified bytes are a proxy for logic that comments and formatting do not move. It
     * stops claiming to be the number a reader on a phone pays. That number is measured by
     * `measureClientJs` in `@weftjs/core`, gated by `budget({ js, grow })`, and reported by
     * `weft build`.
     */
    id: 'front-door',
    label: 'The front door’s code, bundled and minified — not what a page downloads',
    entry: front('boot.ts'),
    limit: 14 * 1024,
    limitNote:
      'no design figure; a watermark over how much code the front door is. 12 KB when the exposed table landed, 13 KB when the refresh interval and the patch applier did, 14 KB when the channel got a socket — see spec/kernel/budgets.md',
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

/**
 * Where a measured run is written, so something other than a terminal can read it.
 *
 * `weft.budget.json` beside the documentation site already does this for that site's own weight,
 * and the note in it is the argument for both: *commit this — a growth cap is a diff*. The same
 * holds here. These numbers come out of a bundler and a compressor, which is twenty seconds of work
 * and two dependencies a documentation page cannot take on to render a line; measured once and
 * committed, the number on the page is the number the gate last saw.
 *
 * What is deliberately not recorded is a timestamp or a commit. Either would make every run a diff
 * even when no size moved, which is the thing that trains people to stop reading the diff.
 */
export const MEASURED = fileURLToPath(new URL('../budgets.json', import.meta.url))

export interface MeasuredBudget {
  id: string
  raw: number
  gzip: number
  brotli: number
}

/** The sizes, smallest key set that is useful: the ceiling and the label already live in source. */
export function recordBudgets(sizes: readonly BundleSize[]): MeasuredBudget[] {
  return sizes
    .map((size) => ({ id: size.id, raw: size.raw, gzip: size.gzip, brotli: size.brotli }))
    .toSorted((a, b) => a.id.localeCompare(b.id))
}
