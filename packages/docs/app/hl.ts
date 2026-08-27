import { escapeHtml } from './escape.ts'

/**
 * Syntax highlighting for the four languages this site prints, and nothing else.
 *
 * It sits beside `client.ts` rather than in `lib/` because the browser needs it too: the
 * playground's editor re-highlights what you type, and a second implementation of a highlighter is
 * a second set of rules for which word is a keyword. One module, stripped of its types by Node and
 * served as written — which is what the framework does with every client module.
 *
 * Hand-written rather than a dependency, for two reasons that both point the same way. The site
 * prints `tsx`, `ts`, `sh` and `json` and will not grow a fifth without somebody deciding to, so a
 * general grammar engine would be carrying a hundred languages to serve four. And a highlighter is
 * the one thing on a documentation site that cannot be wrong in an interesting way: it either bolds
 * the right word or it does not, and a test can say which.
 *
 * The one rule that matters for correctness: the scanners run over the *raw* source and every token
 * is escaped as it is emitted. Running a regex over already-escaped HTML is how a highlighter starts
 * matching `&quot;` as a string delimiter and emitting tags inside attribute values.
 */

type Kind =
  | 'comment'
  | 'string'
  | 'number'
  | 'keyword'
  | 'type'
  | 'tag'
  | 'attr'
  | 'key'
  | 'command'
  | 'flag'
  | 'punct'
  | 'plain'

interface Token {
  kind: Kind
  text: string
}

/** Reserved words, and the handful of ambient names that read as language rather than library. */
const KEYWORDS = new Set([
  'as',
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'declare',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'from',
  'function',
  'get',
  'if',
  'implements',
  'import',
  'in',
  'infer',
  'instanceof',
  'interface',
  'is',
  'keyof',
  'let',
  'new',
  'null',
  'of',
  'private',
  'protected',
  'public',
  'readonly',
  'return',
  'satisfies',
  'set',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'type',
  'typeof',
  'undefined',
  'var',
  'void',
  'while',
  'yield',
])

/** The primitives, which are types but are spelled in lower case and so miss the capital rule. */
const PRIMITIVES = new Set([
  'any',
  'bigint',
  'boolean',
  'never',
  'number',
  'object',
  'string',
  'symbol',
  'unknown',
])

/**
 * One pass, longest-plausible-token-first.
 *
 * Order is the whole specification. A comment has to be tried before the division operator or `//`
 * is two punctuation marks; a template literal before a string; a number before an identifier, or
 * `1e9` becomes a number followed by a name.
 */
const TS = new RegExp(
  [
    '(?<comment>//[^\\n]*|/\\*[\\s\\S]*?\\*/)',
    '(?<string>`(?:\\\\[\\s\\S]|[^`\\\\])*`|\'(?:\\\\[\\s\\S]|[^\'\\\\\\n])*\'|"(?:\\\\[\\s\\S]|[^"\\\\\\n])*")',
    '(?<number>\\b\\d[\\w.]*)',
    '(?<close></\\s*[A-Za-z][\\w.-]*\\s*>)',
    '(?<open><\\s*[A-Za-z][\\w.-]*)',
    '(?<word>[A-Za-z_$][\\w$]*)',
    '(?<space>\\s+)',
    '(?<punct>[^\\sA-Za-z_$\\d]+)',
  ].join('|'),
  'gy',
)

function scanTs(source: string): Token[] {
  const out: Token[] = []
  TS.lastIndex = 0
  let at = 0
  while (at < source.length) {
    TS.lastIndex = at
    const match = TS.exec(source)
    // A character no branch claims: emit it raw and step past, so a stray byte cannot spin the loop.
    if (!match) {
      out.push({ kind: 'plain', text: source[at] as string })
      at += 1
      continue
    }
    const g = match.groups as Record<string, string | undefined>
    const text = match[0] as string
    if (g.comment !== undefined) out.push({ kind: 'comment', text })
    else if (g.string !== undefined) out.push({ kind: 'string', text })
    else if (g.number !== undefined) out.push({ kind: 'number', text })
    else if (g.close !== undefined || g.open !== undefined) out.push({ kind: 'tag', text })
    else if (g.space !== undefined) out.push({ kind: 'plain', text })
    else if (g.punct !== undefined) out.push({ kind: 'punct', text })
    else if (g.word !== undefined) {
      const word = g.word
      // A capital first letter means a type or a component here. That is a convention rather than a
      // parse, and it is the convention this codebase actually follows.
      const kind: Kind = KEYWORDS.has(word)
        ? 'keyword'
        : PRIMITIVES.has(word) || /^[A-Z]/.test(word)
          ? 'type'
          : 'plain'
      out.push({ kind, text })
    }
    at = TS.lastIndex
  }
  return out
}

const SH = new RegExp(
  [
    '(?<comment>#[^\\n]*)',
    '(?<string>\'[^\'\\n]*\'|"[^"\\n]*")',
    '(?<flag>(?<=\\s)--?[\\w-]+)',
    '(?<word>[^\\s]+)',
    '(?<space>\\s+)',
  ].join('|'),
  'gy',
)

/**
 * Shell, where the only distinctions worth drawing are the comment, the command and its flags.
 *
 * The command is the first word of a line, which is what `fresh` tracks. Highlighting shell as if it
 * were a programming language — keywords, operators, types — reads as noise on a page whose shell
 * blocks are all one line of `weft something --flag`.
 */
function scanSh(source: string): Token[] {
  const out: Token[] = []
  let at = 0
  let fresh = true
  while (at < source.length) {
    SH.lastIndex = at
    const match = SH.exec(source)
    if (!match) {
      out.push({ kind: 'plain', text: source[at] as string })
      at += 1
      continue
    }
    const g = match.groups as Record<string, string | undefined>
    const text = match[0] as string
    if (g.comment !== undefined) out.push({ kind: 'comment', text })
    else if (g.string !== undefined) out.push({ kind: 'string', text })
    else if (g.flag !== undefined) out.push({ kind: 'flag', text })
    else if (g.space !== undefined) {
      out.push({ kind: 'plain', text })
      if (text.includes('\n')) fresh = true
    } else if (g.word !== undefined) {
      out.push({ kind: fresh ? 'command' : 'plain', text })
      fresh = false
    }
    at = SH.lastIndex
  }
  return out
}

const JSON_RE = new RegExp(
  [
    '(?<key>"(?:\\\\.|[^"\\\\])*"(?=\\s*:))',
    '(?<string>"(?:\\\\.|[^"\\\\])*")',
    '(?<number>-?\\b\\d[\\w.+-]*)',
    '(?<word>\\b(?:true|false|null)\\b)',
    '(?<space>\\s+)',
    '(?<punct>[^\\s"\\d\\w]+)',
    '(?<other>[\\w]+)',
  ].join('|'),
  'gy',
)

/** JSON, where a quoted run before a colon is a key and every other quoted run is a value. */
function scanJson(source: string): Token[] {
  const out: Token[] = []
  let at = 0
  while (at < source.length) {
    JSON_RE.lastIndex = at
    const match = JSON_RE.exec(source)
    if (!match) {
      out.push({ kind: 'plain', text: source[at] as string })
      at += 1
      continue
    }
    const g = match.groups as Record<string, string | undefined>
    const text = match[0] as string
    if (g.key !== undefined) out.push({ kind: 'key', text })
    else if (g.string !== undefined) out.push({ kind: 'string', text })
    else if (g.number !== undefined) out.push({ kind: 'number', text })
    else if (g.word !== undefined) out.push({ kind: 'keyword', text })
    else if (g.punct !== undefined) out.push({ kind: 'punct', text })
    else out.push({ kind: 'plain', text })
    at = JSON_RE.lastIndex
  }
  return out
}

function scan(language: string, source: string): Token[] {
  if (language === 'sh' || language === 'bash' || language === 'shell') return scanSh(source)
  if (language === 'json') return scanJson(source)
  if (language === 'ts' || language === 'tsx' || language === 'js' || language === 'jsx') {
    return scanTs(source)
  }
  return [{ kind: 'plain', text: source }]
}

/**
 * Source into highlighted HTML, escaped.
 *
 * `plain` gets no element at all rather than a `<span class="t-plain">`, which is most of the bytes
 * on a page of code: wrapping whitespace and punctuation-free identifiers in an element that styles
 * nothing is how a highlighter doubles the size of a document for no visible difference. Adjacent
 * tokens of the same kind are merged for the same reason.
 *
 * An unknown language falls through to escaped text, so a block is never worse than it was before
 * this file existed.
 */
export function highlight(language: string, source: string): string {
  const tokens = scan(language, source)
  let html = ''
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as Token
    if (token.kind === 'plain') {
      html += escapeHtml(token.text)
      continue
    }
    let text = token.text
    while (i + 1 < tokens.length && (tokens[i + 1] as Token).kind === token.kind) {
      text += (tokens[i + 1] as Token).text
      i++
    }
    html += `<span class="t-${token.kind}">${escapeHtml(text)}</span>`
  }
  return html
}
