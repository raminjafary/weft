import { defineRoute } from '@weft/core'

/**
 * A page that fails to render at build time.
 *
 * The kernel degrades a slot that throws to its placeholder, which is the right answer for a
 * request and the wrong one for a file: written out, the failure becomes a page that looks
 * deliberate and never fails again.
 */
export default defineRoute({
  head: { title: 'A slot that throws' },
  slots: {
    body: {
      stream: false,
      html: () => {
        throw new Error('this loader cannot run')
      },
    },
  },
})
