import { fragment } from 'weft'

interface SlotsProps {
  title: string
  /** Slow: a region the shell refuses to wait for, and first in document order. */
  feed: string
  /** Fast: the region that proves nothing waits on document order. */
  recs: string
}

export default fragment(({ title, feed, recs }: SlotsProps) => (
  <>
    <h1>{title}</h1>
    <section id="feed">
      <slot name="feed">{feed}</slot>
    </section>
    <section id="recs">
      <slot name="recs">{recs}</slot>
    </section>
  </>
))
