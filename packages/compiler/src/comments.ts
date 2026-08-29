import { parseSync } from 'oxc-parser'

/** A module's prose, removed for the browser that will never read it. See `spec/kernel/static.md`. */
export interface StripCommentsResult {
  code: string
  /** How many bytes of prose came out, for a caller that wants to report the saving. */
  removed: number
}

const KEEP = /^!|@license|@preserve/

/** A module with its prose removed, and the number of bytes that was. See `spec/kernel/static.md`. */
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
