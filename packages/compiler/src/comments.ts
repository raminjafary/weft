import { parseSync } from 'oxc-parser'

/**
 * A module's prose, removed for the browser that will never read it.
 *
 * This codebase explains itself in comments — long ones, on nearly every function — and until now
 * every byte of that shipped. `stripTypeScriptTypes` with `mode: 'strip'` replaces type annotations
 * with whitespace and deliberately keeps comments, which is right for a source map and wrong for a
 * production payload: `boot.ts` alone is 101 KB raw, and condensing six comment blocks in it took
 * about a kilobyte off the wire, brotli.
 *
 * **Why it is here and not in `weft`.** Doing this correctly is a parsing problem, not a regular
 * expression. `//` inside a string is not a comment; `/*` inside a template literal is not a
 * comment; and `/` is a comment, a division and a regular expression delimiter depending on what
 * came before it. A tokenizer that gets that wrong does not fail loudly — it removes a slice of a
 * working program and ships it. The compiler is the package that already understands source text
 * and already owns the only third-party parser this framework has, so the exact answer is free
 * here and would be a new dependency and a new class of bug anywhere else.
 *
 * **What is kept.** A comment beginning `/*!`, or carrying `@license` or `@preserve`, on the
 * convention every minifier follows: those exist for a legal reason and removing them is not a
 * size decision to make on somebody's behalf.
 *
 * **What replaces a comment that spanned lines.** A newline, not nothing. A block comment
 * containing a line break can be the only thing separating two statements —
 * `const a = 1 /*\n*\/ const b = 2` is valid and becomes a syntax error if the break goes with it.
 * That is the one way this transform could produce a broken module, so it is the one case it
 * handles by construction rather than by hoping.
 */
export interface StripCommentsResult {
  code: string
  /** How many bytes of prose came out, for a caller that wants to report the saving. */
  removed: number
}

const KEEP = /^!|@license|@preserve/

/**
 * A module with its prose removed, and the number of bytes that was.
 *
 * Exact rather than approximate: the comment spans come from the parser, so a `//` inside a string,
 * a `/*` inside a template literal and a `/` that is division rather than a regular expression are
 * all decided by the same thing that decides them for the runtime. A block comment that spanned
 * lines leaves a newline behind, because it may have been the only statement separator there was.
 */
export function stripComments(file: string, source: string): StripCommentsResult {
  const parsed = parseSync(file, source, { sourceType: 'module', preserveParens: false })
  const comments = (parsed as unknown as { comments?: { value: string; start: number; end: number }[] })
    .comments
  if (!comments?.length) return { code: source, removed: 0 }

  let code = source
  let removed = 0
  // Back to front, so an earlier comment's offsets are still the offsets of the string being cut.
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i] as { value: string; start: number; end: number }
    if (KEEP.test(c.value)) continue
    const text = code.slice(c.start, c.end)
    // A break inside the comment may be the only statement separator there is.
    const replacement = text.includes('\n') ? '\n' : ''
    code = code.slice(0, c.start) + replacement + code.slice(c.end)
    removed += text.length - replacement.length
  }
  return { code, removed }
}
