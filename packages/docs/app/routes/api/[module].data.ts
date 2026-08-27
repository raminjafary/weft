import { defineRoute } from '@weft/core'
import { apiContents } from '../../lib/contents.ts'
import { GENERATED, shell } from '../../lib/shell.ts'
import { moduleBody, moduleIds, moduleOutline } from '../../lib/api-page.ts'
import { moduleById } from '../../lib/surface.ts'

/**
 * One route for the whole API reference.
 *
 * Nine entry points and well over a thousand names behind one pattern, one plan and one sealed
 * template. The
 * `params` set is the module list, which the surface walk produced — so the build writes a file per
 * module and none of them needs the kernel at serve time.
 */
export default defineRoute({
  head: (params) => ({
    title: `${moduleById(params.module ?? '')?.specifier ?? 'Not found'} · weft API`,
    description: moduleById(params.module ?? '')?.blurb ?? 'No such module.',
  }),
  layoutValues: (params) =>
    shell({
      ...GENERATED,
      kickerNote: "walked out of the package's public entry",
      heading: moduleById(params.module ?? '')?.specifier ?? 'Not found',
      lede: moduleById(params.module ?? '')?.blurb ?? 'This module does not exist.',
      section: 'Packages',
    }),
  cache: { class: 'public', ttl: '1h' },
  params: { module: moduleIds() },
  slots: {
    contents: { fragment: 'docs/contents', load: (_ctx, params) => ({ groups: apiContents(params.module) }) },
    body: { html: (_ctx, params) => moduleBody(params.module ?? '') },
    outline: { html: (_ctx, params) => moduleOutline(params.module ?? '') },
  },
})
