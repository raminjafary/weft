const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/**
 * Text into HTML text, and the reason this is a file of its own.
 *
 * It lived in `markup.ts` until `highlight.ts` needed it, at which point the two imported each other
 * — `markup` for the highlighter, `highlight` for the escaper. That cycle happens to be harmless
 * (both bindings are only reached at render time, long after evaluation) which is exactly what makes
 * it worth removing rather than living with: the next thing added to either file is what would find
 * out that it is not harmless any more.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c] as string)
}
