/**
 * What the compiler will say, worked out while you are still typing.
 *
 * The playground compiles on the server, because the compiler is the only thing entitled to say
 * what a fragment lowers to. A round trip per keystroke is not that, though — so this is the
 * cheaper half, running in the browser: a scan that reads the props interface, finds the holes in
 * the JSX, and pairs them up. It is a *hint*, and the panel says so; the compile beside it is the
 * answer.
 *
 * Two rules keep the hint honest rather than merely encouraging.
 *
 * **It never claims more than it can see.** A binding with no declared type is reported as unknown
 * and gets the conservative escape, which is what the compiler would do with it. A hole whose
 * binding is not in the props at all is reported as unknown *and* flagged, because that is a real
 * mistake and the earlier a reader sees it the better.
 *
 * **It says where it disagrees with the page it is on.** Escape elision is a type question and the
 * playground's file set is virtual, so the compiler there escapes everything. This scan can still
 * read `count: number` and say what elision *would* do with a real file — so it reports both, and
 * the difference is the point rather than a discrepancy somebody has to notice.
 *
 * No parser and no dependency. The playground accepts one module with one default-exported
 * fragment, which is a small enough shape that a scan is honest about it and a 7 MB checker in the
 * browser would be an odd thing to download to be told `count` is a number.
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

/**
 * Every `name: Type` pair declared anywhere in the module.
 *
 * Deliberately flat: an `interface Props`, an inline `{ a: string }` annotation and a nested
 * interface all contribute to one table. A fragment small enough for this page does not have two
 * different `count`s, and pretending to resolve scopes with a regex would be the kind of accuracy
 * that is wrong in a way nobody can see.
 */
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

/**
 * The holes: `{binding}` between tags, `attr={binding}` on one, and `{rows.map(` for a list.
 *
 * Only the head of a member expression is reported — `{r.price}` inside a row is the row's, and the
 * binding a reader can act on is `rows`. That is also what the compiler records, so the two agree
 * about what a hole is called even where they disagree about its type.
 */
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
  // Every `{binding}`, classified by the character before it: an `=` makes it an attribute, and
  // anything else makes it text. Scanning for the brace rather than for the tag around it is what
  // finds the second hole in `<b>{count}</b>{unit}` — a pair the earlier shape missed, because it
  // looked for the `>` and there is a `}` in the way.
  //
  // Two shapes read identically to a scan and are not holes: `import { fragment }` and the
  // destructured parameter `({ label }: Props)`. Both are decided by what comes *after* the closing
  // brace — `from` for one, `:` or `)` for the other — so that is what is looked at, rather than
  // guessing from the name.
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
