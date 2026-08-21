import { fragment } from 'weft'

interface Props {
  count: number
  parity: string
}

/**
 * A page that writes something.
 *
 * The two buttons name an intent. With JavaScript they go over the channel: the client stages an
 * optimistic guess into an epoch that paints nothing, the server stages the truth into the same
 * epoch, and one commit replaces one with the other in a single paint. With JavaScript off they
 * are a form post to the same intent, which answers with a 303 back to this page.
 *
 * Nothing on this page is a client component. The count is a text hole the server filled, and it
 * moves because the region is live: an intent invalidated the tag it declared, every connection
 * showing this region was told, and each asked for a delta.
 */
export default fragment(({ count, parity }: Props) => (
  <div class="counter">
    <output class="counter-value" data-parity={parity}>
      {count}
    </output>
    <form class="weft-row" method="post" action="/_weft/i/counter.bump" data-weft-intent="counter.bump">
      <input type="hidden" name="by" value="1" />
      <button type="submit" data-variant="primary">
        add one
      </button>
    </form>
    <form class="weft-row" method="post" action="/_weft/i/counter.reset" data-weft-intent="counter.reset">
      <button type="submit">reset</button>
    </form>
    <p class="weft-hint">
      Open this page in two tabs and press the button in one. The other one updates without asking, because
      the intent said what it writes.
    </p>
  </div>
))
