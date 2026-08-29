import { fragment } from '@weftjs/core'

export interface NoteProps {
  /** `why`, `refused` or `careful` — the class decides the accent, so it is a value not a branch. */
  kind: string
  title: string
  body: string
}

/**
 * The aside the guide uses to say why, refuse something, or warn. `body` is one hole that escapes,
 * replacing `markup.ts`'s `note()` where every call site hand-escaped its own HTML. `kind` reaches
 * the class through a template literal rather than three branches — one hole, not three sealed
 * templates, for a difference CSS already knows how to make.
 */
export default fragment(({ kind, title, body }: NoteProps) => (
  <aside class={`note note-${kind}`}>
    <h4>{title}</h4>
    <p>{body}</p>
  </aside>
))
