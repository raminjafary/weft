import { fragment } from 'weft'
import Card from '../../fragments/card.tsx'

interface Note {
  title: string
  body: string
}

interface Props {
  topic: string
  intro: string
  notes: Note[]
  firstTitle: string
  firstBody: string
  secondTitle: string
  secondBody: string
}

/**
 * A route with a parameter, and a component rendered twice.
 *
 * `[topic].tsx` becomes `/guide/:topic`. The parameter is a read the compiler can name, so it is
 * already part of this page's cache key and nothing had to declare that.
 *
 * `Card` is sealed once. Rendering it twice adds two cards of content and no template: the parent
 * projects values into the child's holes rather than mounting it.
 */
export default fragment(({ topic, intro, notes, firstTitle, firstBody, secondTitle, secondBody }: Props) => (
  <>
    <h1>{topic}</h1>
    <p class="weft-lede">{intro}</p>
    <div class="weft-grid">
      <Card title={firstTitle} body={firstBody} />
      <Card title={secondTitle} body={secondBody} />
    </div>
    <dl class="weft-readout">
      {notes.map((note) => (
        <div class="note">
          <dt>{note.title}</dt>
          <dd class="weft-note">{note.body}</dd>
        </div>
      ))}
    </dl>
  </>
))
