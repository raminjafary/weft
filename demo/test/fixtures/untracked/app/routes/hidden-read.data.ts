import { defineRoute } from '@weftjs/core'

/**
 * The read the compiler cannot see.
 *
 * A fragment that reads a cookie is refused structurally: the compiler tracked the read, the
 * effect set carries it, and the page is classified `shared` before anything renders. This does
 * the same read from the route's own declaration, which is a `.ts` file nothing compiles — so the
 * effect set says the page reads nothing and the effect set is wrong.
 *
 * It exists to be caught by the render rather than by the classifier.
 */
export default defineRoute({
  head: { title: 'A loader that reads a cookie' },
  slots: {
    body: {
      stream: false,
      html: (ctx) => `<p>theme: ${ctx.cookie('theme') ?? 'none'}</p>`,
    },
  },
})
