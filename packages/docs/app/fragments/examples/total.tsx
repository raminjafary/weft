import { fragment } from '@weftjs/core'

/**
 * Escape elision is a type question.
 *
 * `count` is a number, so no value it can hold needs escaping and the compiler drops the escape
 * call entirely — the hole's class is `proven-safe`. `name` is a string, so it keeps `escape`.
 * Nothing here declares either; the difference is the annotation two lines down.
 */
export default fragment(({ name, count }: { name: string; count: number }) => (
  <p class="total">
    <b>{name}</b> — {count} items
  </p>
))
