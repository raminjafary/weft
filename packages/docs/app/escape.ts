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
 * It sits at the top of `app/` rather than in `lib/` because the browser imports it: the framework
 * serves `client.ts` and its siblings, and a subdirectory under that tree is refused — deliberately,
 * since the tree is a public surface and `lib/` is full of modules that open files. So the two
 * modules the editor needs live beside `client.ts`, and `lib/` re-exports them for everything else.
 *
 * It lived in `markup.ts` until the highlighter needed it, at which point the two imported each other
 * — `markup` for the highlighter, `highlight` for the escaper. That cycle happens to be harmless
 * (both bindings are only reached at render time, long after evaluation) which is exactly what makes
 * it worth removing rather than living with: the next thing added to either file is what would find
 * out that it is not harmless any more.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c] as string)
}
