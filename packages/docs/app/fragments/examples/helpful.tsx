import { fragment } from 'weft'

/**
 * A mutation with no JavaScript on the page at all.
 *
 * The form posts to `/_weft/i/docs.helpful`, which is the route the intent manifest generated from
 * `app/intents/feedback.ts`. Phase A dispatch means a real status code, a cookie the server may set
 * `HttpOnly`, and a 303 back here — the three things a `fetch` handler cannot give you and the
 * reason the no-JavaScript path is the *first* path rather than the fallback.
 *
 * The same intent, unchanged, is what a client would dispatch over the channel. There is no second
 * endpoint and no second handler.
 */
export default fragment(({ page, count }: { page: string; count: number }) => (
  <form class="vote" method="post" action="/_weft/i/docs.helpful">
    <input type="hidden" name="page" value={page} />
    <button type="submit">Useful</button>
    <span class="count">{count}</span>
  </form>
))
