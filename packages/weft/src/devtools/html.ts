/**
 * The devtools pages' own markup, written by hand and served as a string.
 *
 * Everything else this framework renders goes through the compiler and a sealed template, and
 * these pages deliberately do not. A second compile would put the compiler on the path of the
 * one page you open when the compiler is what you are trying to understand, and it would put
 * the framework's own fragments in the application's fragment table — which is the namespacing
 * that made mounting a second application inside the first the wrong answer.
 *
 * So: no template, no stylesheet in the asset table, no client module. A devtools page adds
 * nothing to what the application serves and nothing to what it measures.
 */
const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escape(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ESCAPES[character] as string)
}

export function code(value: unknown): string {
  return `<code>${escape(value)}</code>`
}

/** A list of values, or the dash that says there are none — never an empty cell. */
export function list(values: readonly unknown[]): string {
  return values.length ? values.map((value) => code(value)).join(' ') : '<span class="none">—</span>'
}

export function maybe(value: unknown): string {
  return value === undefined || value === null || value === '' ? '<span class="none">—</span>' : code(value)
}

export function bytes(count: number): string {
  return `${count.toLocaleString('en-US')}<span class="unit"> B</span>`
}

export function pre(text: string): string {
  return `<pre>${escape(text)}</pre>`
}

/**
 * Cells are HTML, not text: every one of them is built here from `code`, `list` or `escape`,
 * so nothing reaches a page without having gone through one of them.
 */
export function table(head: readonly string[], rows: readonly string[][]): string {
  if (!rows.length) return '<p class="none">nothing</p>'
  const header = head.map((column) => `<th>${escape(column)}</th>`).join('')
  const body = rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')
  return `<div class="scroll"><table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div>`
}

export function section(title: string, body: string, note?: string): string {
  return `<section><h2>${escape(title)}</h2>${note ? `<p class="note">${note}</p>` : ''}${body}</section>`
}

/** A refusal, rendered the way the rest of the framework states one: the code, then the fix. */
export function refusal(code_: string, message: string): string {
  return `<div class="refusal"><strong>${escape(code_)}</strong><p>${escape(message)}</p></div>`
}

export const PAGES: readonly { path: string; label: string }[] = [
  { path: '', label: 'Overview' },
  { path: 'routes', label: 'Routes' },
  { path: 'why', label: 'Why' },
  { path: 'fragments', label: 'Fragments' },
  { path: 'intents', label: 'Intents' },
  { path: 'bytes', label: 'Bytes' },
]

const STYLE = `
:root { color-scheme: light dark; --line: color-mix(in srgb, currentColor 15%, transparent);
  --dim: color-mix(in srgb, currentColor 55%, transparent); --bg: Canvas; --accent: #6b4dff; }
* { box-sizing: border-box }
body { margin: 0; background: var(--bg); font: 14px/1.55 ui-sans-serif, system-ui, sans-serif;
  -webkit-text-size-adjust: 100% }
header { border-bottom: 1px solid var(--line); padding: 1.1rem 1.4rem .8rem }
header h1 { margin: 0 0 .15rem; font-size: 1rem; letter-spacing: .02em }
header p { margin: 0; color: var(--dim); font-size: .8rem }
nav { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .8rem }
nav a { padding: .2rem .6rem; border: 1px solid var(--line); border-radius: 99px;
  text-decoration: none; color: inherit; font-size: .8rem }
nav a[aria-current] { border-color: var(--accent); color: var(--accent) }
main { padding: 1.2rem 1.4rem 4rem; max-width: 1200px }
section { margin: 0 0 2.2rem }
h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .09em; color: var(--dim);
  margin: 0 0 .5rem; font-weight: 600 }
h3 { font-size: .95rem; margin: 1.4rem 0 .4rem; font-family: ui-monospace, SFMono-Regular, monospace }
h3 a { color: var(--accent); font-size: .72rem; font-family: inherit; text-decoration: none;
  margin-left: .6rem; font-weight: 400 }
p.note { margin: 0 0 .6rem; color: var(--dim); max-width: 78ch }
.scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 6px }
table { border-collapse: collapse; width: 100%; font-size: .8rem }
th, td { text-align: left; padding: .35rem .6rem; border-bottom: 1px solid var(--line);
  vertical-align: top; white-space: nowrap }
th { color: var(--dim); font-weight: 600; text-transform: uppercase; letter-spacing: .05em;
  font-size: .68rem }
tbody tr:last-child td { border-bottom: 0 }
code { font-family: ui-monospace, SFMono-Regular, monospace; font-size: .95em }
.none { color: var(--dim) }
.unit { color: var(--dim) }
td.num { text-align: right; font-variant-numeric: tabular-nums }
pre { overflow-x: auto; border: 1px solid var(--line); border-radius: 6px; padding: .8rem 1rem;
  font-size: .78rem; line-height: 1.5; margin: 0 }
details { border: 1px solid var(--line); border-radius: 6px; padding: .5rem .8rem; margin: .5rem 0 }
summary { cursor: pointer; font-size: .8rem; color: var(--dim) }
details[open] summary { margin-bottom: .6rem }
.refusal { border: 1px solid var(--accent); border-radius: 6px; padding: .7rem 1rem; margin: 0 0 1rem }
.refusal strong { font-family: ui-monospace, SFMono-Regular, monospace; font-size: .8rem;
  color: var(--accent) }
.refusal p { margin: .3rem 0 0; font-size: .85rem }
form.params { display: flex; flex-wrap: wrap; gap: .4rem; margin: 0 0 .8rem; align-items: center }
form.params input, form.params select { font: inherit; font-size: .8rem; padding: .2rem .4rem;
  border: 1px solid var(--line); border-radius: 4px; background: transparent; color: inherit }
form.params button { font: inherit; font-size: .8rem; padding: .22rem .7rem; border-radius: 4px;
  border: 1px solid var(--accent); background: transparent; color: var(--accent); cursor: pointer }
a { color: var(--accent) }
`

export interface Shell {
  /** Which nav entry is the current one, by its path segment. */
  current: string
  title: string
  /** The application this is pointed at, and the mode it is running in. */
  subtitle: string
  root: string
  body: string
}

export function document_(shell: Shell): string {
  const nav = PAGES.map(
    (page) =>
      `<a href="${escape(`${shell.root}${page.path ? `/${page.path}` : ''}`)}"${
        page.path === shell.current ? ' aria-current="page"' : ''
      }>${escape(page.label)}</a>`,
  ).join('')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escape(shell.title)} · weft devtools</title>
<style>${STYLE}</style></head>
<body><header><h1>weft devtools · ${escape(shell.title)}</h1>
<p>${escape(shell.subtitle)}</p>
<nav>${nav}</nav></header>
<main>${shell.body}</main></body></html>`
}
