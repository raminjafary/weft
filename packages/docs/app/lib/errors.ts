import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The error reference, read out of the source that throws.
 *
 * Every refusal in this framework is a named code with a sentence attached, and the sentence is
 * already the best available explanation — it was written to be read by whoever hit it. So this page
 * is not a second set of prose about those codes: it is the codes, the messages, and the file that
 * raises each one, extracted. A code added to the framework appears here without anybody
 * remembering to add it, which is the only way a reference of this size stays true.
 *
 * `test/docs.test.ts` scans the same tree independently and fails when a code exists in `src/` and
 * not on the page. That is what makes "every error is documented" a gate.
 */
export interface ErrorSite {
  /** Repository-relative file, and the line the code appears on. */
  file: string
  line: number
  /** The message text as written, when the code is thrown with one. */
  message?: string
}

/**
 * How much this code says when it is raised.
 *
 * Three states rather than two, because "no literal message" and "no message" are different things.
 * A code that forwards an underlying failure — `${(error as Error).message}`, `reasonOf(error)`, a
 * parsed reply's own error — does have a sentence at runtime; it just is not in the source to
 * extract. Calling that bare would be a complaint about the extractor dressed as a complaint about
 * the framework, and the count that matters is the third state.
 */
export type ErrorDetail = 'prose' | 'wrapped' | 'none'

export interface ErrorCode {
  code: string
  /** Which package raises it. The first one, when more than one does. */
  package: string
  /** Where it is raised, in file order. */
  sites: ErrorSite[]
  /** The longest message found for this code: the one that explains the most. */
  message: string
  /** Whether that message is a sentence, a forwarded failure, or absent. */
  detail: ErrorDetail
  /** Spec documents that mention it, so a reader can find the argument rather than the string. */
  spec: string[]
}

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const CODE = /\b([EW]_[A-Z][A-Z0-9_]*)\b/g

function walk(dir: string, out: string[]): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries.sort()) {
    if (name === 'node_modules' || name === 'dist' || name === '.weft') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (name.endsWith('.ts') || name.endsWith('.tsx')) out.push(path)
  }
  return out
}

/**
 * The message a code is raised with.
 *
 * The call around the code is found by balancing parentheses rather than by matching a pattern,
 * because this codebase raises codes four different ways — `new Error(`E_X: …`)`, a named error
 * class taking the code and the message apart, a `fail(code, path, message)` collector, and an issue
 * pushed onto a diagnostics array. All four put the sentence in a string inside the same call, so the
 * longest string in that call is the message, and no fifth spelling has to be anticipated.
 *
 * Interpolations become an ellipsis and concatenations are joined. That is a reconstruction, and the
 * page says so rather than presenting it as the literal runtime text.
 */
function enclosing(source: string, index: number, open: string, close: string): string | undefined {
  let depth = 0
  let start = -1
  for (let i = index; i >= 0 && index - i < 700; i--) {
    const char = source[i]
    if (char === close) depth++
    else if (char === open) {
      if (depth === 0) {
        start = i
        break
      }
      depth--
    }
  }
  if (start < 0) return undefined
  let end = -1
  depth = 0
  for (let i = start; i < source.length && i - start < 4000; i++) {
    const char = source[i]
    if (char === open) depth++
    else if (char === close) {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end < 0) return undefined
  return source.slice(start + 1, end)
}

const QUOTES = new Set(['`', "'", '"'])

interface Literal {
  /** The literal's text, with every interpolation collapsed to an ellipsis. */
  text: string
  /** Where its closing quote is, so a scan can carry on past it. */
  end: number
}

/**
 * One string or template literal, read from its opening quote.
 *
 * Scanned rather than matched, because an interpolation may hold another template literal — this
 * repository writes one wherever a message names both halves of what it refused — and a pattern
 * that stopped at the first backtick it met read the tail of the inner one as a message of its own.
 * That is how `E_ETAG_STREAMS` came to be published as ": 'declares out-of-order delivery' }. An
 * entity tag is a digest…", which is the middle of a sentence whose beginning was thrown away.
 */
function literalAt(source: string, start: number): Literal | undefined {
  const quote = source[start]
  let text = ''
  for (let at = start + 1; at < source.length; at++) {
    const char = source[at]
    if (char === '\\') {
      text += source.slice(at, at + 2)
      at++
      continue
    }
    if (char === quote) return { text, end: at }
    if (quote === '`' && char === '$' && source[at + 1] === '{') {
      const close = interpolationEnd(source, at + 2)
      if (close < 0) return undefined
      text += '…'
      at = close
      continue
    }
    if (quote !== '`' && char === '\n') return undefined
    text += char
  }
  return undefined
}

/** The `}` that closes an interpolation, counting braces and stepping over the literals between. */
function interpolationEnd(source: string, from: number): number {
  let depth = 1
  for (let at = from; at < source.length; at++) {
    const char = source[at] as string
    if (QUOTES.has(char)) {
      const nested = literalAt(source, at)
      if (!nested) return -1
      at = nested.end
      continue
    }
    if (char === '{') depth++
    else if (char === '}' && --depth === 0) return at
  }
  return -1
}

/** Every string and template literal in a call, joined where they were concatenated. */
function stringsIn(call: string): string[] {
  const out: string[] = []
  let current = ''
  for (let at = 0; at < call.length; at++) {
    if (!QUOTES.has(call[at] as string)) continue
    const literal = literalAt(call, at)
    if (!literal) continue
    current += literal.text
    at = literal.end
    const joined = /^\s*\+\s*(?=[`'"])/.exec(call.slice(at + 1))
    if (joined) {
      at += joined[0].length
      continue
    }
    out.push(current)
    current = ''
  }
  if (current) out.push(current)
  return out
}

/**
 * Where the sentence is, given four spellings of the same thing.
 *
 * A code is raised as `new Error(`E_X: …`)`, as a named error class taking the code and the message
 * apart, as `fail(code, path, message)`, and as an object with `code` and `message` beside each
 * other. The first three put it in the enclosing *call*; the fourth in the enclosing *object*, and
 * a structured failure names its field — so a `message:`, `reason:` or `detail:` property wins over
 * the longest string, because the longest string in an object literal is often something else.
 */
/**
 * A scope that hands an underlying failure onward rather than writing its own sentence.
 *
 * `.errors`/`.issues` are here because a collector forwards a *list* rather than one cause —
 * `E_INVALID_DOCUMENT` prints every complaint the template validator made — and at runtime that
 * says a great deal. It is the cause's sentence rather than one written in the source, which is the
 * same bargain the single-cause spellings make, so it belongs in the same state as them.
 */
const FORWARDS =
  /\b(?:error|err|cause)\s*(?:as\s+Error)?\s*\)?\.message|String\(\s*error|reasonOf\(|parsed\.error|lastError|\.stack\b|\.(?:errors|issues)\b/

function forwardsAt(source: string, index: number): boolean {
  for (const open of ['{', '('] as const) {
    const scope = enclosing(source, index, open, open === '{' ? '}' : ')')
    if (scope && FORWARDS.test(scope)) return true
  }
  return false
}

function messageAt(source: string, index: number): string | undefined {
  const scopes = [enclosing(source, index, '{', '}'), enclosing(source, index, '(', ')')].filter(
    (text): text is string => Boolean(text),
  )
  if (!scopes.length) return undefined
  for (const scope of scopes) {
    const named = /\b(?:message|reason|detail)\s*:\s*(?=[`'"])/.exec(scope)
    const literal = named ? literalAt(scope, named.index + named[0].length) : undefined
    const found = literal ? clean(literal.text) : undefined
    if (found && usable(found)) return found.slice(0, 500)
  }
  const call = scopes[scopes.length - 1] as string
  const candidates = stringsIn(call).map(clean).filter(usable)
  const longest = candidates.sort((a, b) => b.length - a.length)[0]
  return longest ? longest.slice(0, 500) : undefined
}

function clean(text: string): string {
  return text
    .replace(/\$\{[^{}]*\}/g, '…')
    .replace(/\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[EW]_[A-Z0-9_]+:?\s*/, '')
    .trim()
}

/**
 * A message whose prose is short because most of it is interpolated still explains something:
 * `known: …` is a sentence and `${JSON.stringify(magic)}` alone is not. So the floor is on the words
 * rather than on the length, which is what tells those two apart.
 */
function usable(text: string): boolean {
  return text.replace(/…/g, '').trim().length >= 6 && /[a-z]{3}/.test(text)
}

let cached: ErrorCode[] | null = null

export function errorCodes(): ErrorCode[] {
  if (cached) return cached
  const found = new Map<string, ErrorCode>()

  const packagesDir = join(ROOT, 'packages')
  for (const pkg of readdirSync(packagesDir).sort()) {
    const src = join(packagesDir, pkg, 'src')
    for (const file of walk(src, [])) {
      const source = readFileSync(file, 'utf8')
      const rel = relative(ROOT, file).split('\\').join('/')
      CODE.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = CODE.exec(source))) {
        const code = match[1] as string
        // `E_INTENT_${response.status}` builds a name at runtime; the prefix is not a code.
        if (source.startsWith('${', match.index + code.length)) continue
        const line = source.slice(0, match.index).split('\n').length
        const message = messageAt(source, match.index + code.length)
        const held =
          found.get(code) ??
          ({ code, package: pkg, sites: [], message: '', detail: 'none', spec: [] } as ErrorCode)
        held.sites.push({ file: rel, line, ...(message ? { message } : {}) })
        if (message && message.length > held.message.length) {
          held.message = message
          held.detail = 'prose'
        }
        if (held.detail === 'none' && forwardsAt(source, match.index + code.length)) {
          held.detail = 'wrapped'
        }
        found.set(code, held)
      }
    }
  }

  // Which spec document argues for it. A code is a string; the argument is a paragraph, and the
  // reader who hit the string is the reader who wants the paragraph.
  const specDir = join(ROOT, 'spec')
  for (const file of walk(specDir, []).concat(mdFiles(specDir))) {
    if (!file.endsWith('.md')) continue
    const source = readFileSync(file, 'utf8')
    const rel = relative(ROOT, file).split('\\').join('/')
    CODE.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = CODE.exec(source))) {
      const held = found.get(match[1] as string)
      if (held && !held.spec.includes(rel)) held.spec.push(rel)
    }
  }

  cached = [...found.values()].sort((a, b) => a.code.localeCompare(b.code))
  return cached
}

function mdFiles(dir: string): string[] {
  const out: string[] = []
  const visit = (at: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(at)
    } catch {
      return
    }
    for (const name of entries.sort()) {
      const path = join(at, name)
      if (statSync(path).isDirectory()) visit(path)
      else if (name.endsWith('.md')) out.push(path)
    }
  }
  visit(dir)
  return out
}

export function errorsByPackage(): { package: string; codes: ErrorCode[] }[] {
  const groups = new Map<string, ErrorCode[]>()
  for (const code of errorCodes()) {
    const held = groups.get(code.package) ?? []
    held.push(code)
    groups.set(code.package, held)
  }
  return [...groups.entries()]
    .map(([name, codes]) => ({ package: name, codes }))
    .sort((a, b) => a.package.localeCompare(b.package))
}

export function errorByCode(code: string): ErrorCode | undefined {
  return errorCodes().find((entry) => entry.code === code)
}
