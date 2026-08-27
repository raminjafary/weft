import { fragment } from 'weft'

export interface NoteProps {
  /** `why`, `refused` or `careful` — the class decides the accent, so it is a value not a branch. */
  kind: string
  title: string
  body: string
}

/**
 * The aside the guide uses to say why, refuse something, or warn.
 *
 * Replaced `markup.ts`'s `note()`, whose `body` was HTML a call site assembled — which is why every
 * note on the site hand-wrote its own `<strong>` and `<code>`. Here the body is one hole and escapes,
 * so a note can carry a term or a message without anybody remembering `escapeHtml`.
 *
 * `kind` reaches the class through a template literal rather than three branches. That is one hole
 * and no extra sealed templates, where a conditional shape would be three of each for a difference
 * CSS already knows how to make.
 */
export default fragment(({ kind, title, body }: NoteProps) => (
  <aside class={`note note-${kind}`}>
    <h4>{title}</h4>
    <p>{body}</p>
  </aside>
))
