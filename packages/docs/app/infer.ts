/**
 * What the compiler will say, worked out while you are still typing — a cheap in-browser scan
 * (reads the props interface, finds JSX holes, pairs them up) rather than a round trip per
 * keystroke. A *hint*, not the answer: it never claims more than it can see (unknown types escape
 * conservatively), and it says where it disagrees with the actual compile — the playground's
 * virtual file set escapes everything, but this scan reports what elision would do on a real file.
 * No parser, no dependency: a 7 MB checker would be a strange download to be told `count` is a number.
 */

/** The escape class the compiler assigns, and the reason it assigns it. */
export type Escape = 'none' | 'text' | 'attr'

export interface Hint {
  binding: string
  /** As written in the props, or `unknown` when nothing declares it. */
  type: string
  /** What escape elision would decide for that type, on a real file. */
  escape: Escape
  /** `text` inside an element, `attr` in an attribute, `list` for a `.map`. */
  where: 'text' | 'attr' | 'list'
  /** 1-based, so it can be pointed at in the editor's gutter. */
  line: number
  /** Set when the binding is used but never declared. */
  undeclared?: boolean
}

export interface Reading {
  /** `ctx.user()` → `identity`, `ctx.now()` → `time`, `ctx.param('x')` → `route:x`. */
  taint: string
  line: number
}

export interface Inference {
  hints: Hint[]
  reads: Reading[]
  /** Derived from the reads exactly as the compiler derives it: no read means static. */
  cacheClass: 'static' | 'shared' | 'private'
  /** What the scan could not account for, in the reader's words. */
  notes: string[]
}

/** A type that cannot hold markup needs no escaping. Everything else is escaped, conservatively. */
const SAFE = new Set(['number', 'bigint', 'boolean', 'true', 'false'])

function escapeFor(type: string, where: Hint['where']): Escape {
  if (where === 'list') return 'text'
  if (SAFE.has(type.trim())) return 'none'
  return where === 'attr' ? 'attr' : 'text'
}

/** Every `name: Type` pair declared anywhere in the module — deliberately flat, since a fragment this small never has two different `count`s. */
function declaredTypes(source: string): Map<string, string> {
  const out = new Map<string, string>()
  const field = /(?:^|[{;,])\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:\s*([^;,}\n]+)/g
  for (const match of source.matchAll(field)) {
    const name = match[1] as string
    const type = (match[2] as string).trim()
    // A JSX attribute or an object literal reads the same to a regex; a type never starts with a
    // quote or a brace, so those are the two cases worth declining rather than guessing at.
    if (/^['"`{[(]/.test(type)) continue
    if (!out.has(name)) out.set(name, type)
  }
  return out
}

const READS: { re: RegExp; taint: (m: RegExpMatchArray) => string }[] = [
  { re: /\bctx\s*\.\s*user\s*\(/g, taint: () => 'identity' },
  { re: /\bctx\s*\.\s*now\s*\(/g, taint: () => 'time' },
  { re: /\bctx\s*\.\s*locale\s*\(/g, taint: () => 'locale' },
  { re: /\bctx\s*\.\s*device\s*\(/g, taint: () => 'device' },
  { re: /\bctx\s*\.\s*param\s*\(\s*['"]([^'"]+)/g, taint: (m) => `route:${m[1]}` },
  { re: /\bctx\s*\.\s*query\s*\(\s*['"]([^'"]+)/g, taint: (m) => `route:${m[1]}` },
  { re: /\bctx\s*\.\s*cookie\s*\(\s*['"]([^'"]+)/g, taint: (m) => `cookie:${m[1]}` },
  { re: /\bctx\s*\.\s*header\s*\(\s*['"]([^'"]+)/g, taint: (m) => `header:${m[1]}` },
  { re: /\bctx\s*\.\s*flag\s*\(/g, taint: () => 'flag' },
  { re: /\bctx\s*\.\s*raw\s*\(/g, taint: () => 'raw — uncacheable' },
]

const lineOf = (source: string, at: number): number => source.slice(0, at).split('\n').length

/** The holes: `{binding}` between tags, `attr={binding}`, `{rows.map(`. Only a member expression's head is reported — `{r.price}` in a row is `rows`, matching what the compiler records. */
function holes(source: string): { binding: string; where: Hint['where']; at: number }[] {
  const out: { binding: string; where: Hint['where']; at: number }[] = []
  const seen = new Set<string>()
  const push = (raw: string, where: Hint['where'], at: number) => {
    const binding = (raw.split('.')[0] as string).trim()
    if (!binding || !/^[A-Za-z_$][\w$]*$/.test(binding)) return
    const key = `${binding}:${where}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ binding, where, at })
  }
  const lists = new Set<string>()
  // A row's own parameter is not a prop and never will be: `{rows.map((r) => …)}` puts `r` in scope
  // for the row template alone, which is why the compiler calls the hole `rows`. Reporting `r` as an
  // undeclared binding would flag the one thing on the page that is certainly correct.
  const rowScoped = new Set<string>()
  for (const match of source.matchAll(/\.\s*map\s*\(\s*\(?\s*([A-Za-z_$][\w$]*)/g)) {
    rowScoped.add(match[1] as string)
  }
  for (const match of source.matchAll(/\{\s*([A-Za-z_$][\w$.]*)\s*\.\s*map\s*\(/g)) {
    const binding = (match[1] as string).split('.')[0] as string
    lists.add(binding)
    push(binding, 'list', match.index ?? 0)
  }
  // Every `{binding}`, classified by the preceding char (`=` → attr, else text). Scans for the brace itself, which is what catches `<b>{count}</b>{unit}`'s second hole.
  // `import { fragment }` and `({ label }: Props)` read the same to a scan; decided by what follows the closing brace (`from`, or `:`/`)`).
  for (const match of source.matchAll(/([=]?)\{\s*([A-Za-z_$][\w$.]*)\s*\}/g)) {
    const at = match.index ?? 0
    const after = source.slice(at + match[0].length).trimStart()
    if (/^(from\b|:|\)|=>)/.test(after)) continue
    const line = source.slice(source.lastIndexOf('\n', at) + 1, at)
    if (/^\s*(import|export)\b/.test(line)) continue
    const binding = (match[2] as string).split('.')[0] as string
    if (lists.has(binding) || rowScoped.has(binding)) continue
    push(binding, match[1] === '=' ? 'attr' : 'text', at)
  }
  return out
}

/** Read a module and say what the compiler is going to make of it. A hint, and it says so. */
export function infer(source: string): Inference {
  const types = declaredTypes(source)
  const hints: Hint[] = holes(source).map(({ binding, where, at }) => {
    const declared = types.get(binding)
    const type = declared ?? 'unknown'
    const hint: Hint = {
      binding,
      type,
      escape: escapeFor(type, where),
      where,
      line: lineOf(source, at),
    }
    if (!declared) hint.undeclared = true
    return hint
  })

  const reads: Reading[] = []
  for (const { re, taint } of READS) {
    for (const match of source.matchAll(re)) {
      reads.push({ taint: taint(match), line: lineOf(source, match.index ?? 0) })
    }
  }

  const notes: string[] = []
  if (hints.some((hint) => hint.escape === 'none')) {
    notes.push(
      'Elision needs a checker, and a virtual file set has no directory to open — so the compile ' +
        'beside this escapes every hole. On a real file the ones marked none would not be escaped.',
    )
  }
  if (hints.some((hint) => hint.undeclared)) {
    notes.push('A binding with no declared type is escaped conservatively, which is what the compiler does.')
  }

  return {
    hints,
    reads,
    cacheClass: reads.some((read) => read.taint === 'identity')
      ? 'private'
      : reads.length
        ? 'shared'
        : 'static',
    notes,
  }
}
