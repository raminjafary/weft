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

export interface ErrorCode {
  code: string
  /** Which package raises it. The first one, when more than one does. */
  package: string
  /** Where it is raised, in file order. */
  sites: ErrorSite[]
  /** The longest message found for this code: the one that explains the most. */
  message: string
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
function callAround(source: string, index: number): string | undefined {
  let depth = 0
  let open = -1
  for (let i = index; i >= 0 && index - i < 600; i--) {
    const char = source[i]
    if (char === ')') depth++
    else if (char === '(') {
      if (depth === 0) {
        open = i
        break
      }
      depth--
    }
  }
  if (open < 0) return undefined
  let close = -1
  depth = 0
  for (let i = open; i < source.length && i - open < 4000; i++) {
    const char = source[i]
    if (char === '(') depth++
    else if (char === ')') {
      depth--
      if (depth === 0) {
        close = i
        break
      }
    }
  }
  if (close < 0) return undefined
  return source.slice(open + 1, close)
}

/** Every string and template literal in a call, joined where they were concatenated. */
function stringsIn(call: string): string[] {
  const out: string[] = []
  const pattern = /(`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")(\s*\+\s*)?/g
  let current = ''
  let match: RegExpExecArray | null
  while ((match = pattern.exec(call))) {
    current += (match[1] as string).slice(1, -1)
    if (match[2]) continue
    out.push(current)
    current = ''
  }
  if (current) out.push(current)
  return out
}

function messageAt(source: string, index: number): string | undefined {
  const call = callAround(source, index)
  if (!call) return undefined
  const candidates = stringsIn(call)
    .map((text) =>
      text
        .replace(/\$\{[^{}]*\}/g, '…')
        .replace(/\\n/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^[EW]_[A-Z0-9_]+:?\s*/, '')
        .trim(),
    )
    .filter((text) => text.length > 15 && /[a-z]{3}/.test(text))
  const longest = candidates.sort((a, b) => b.length - a.length)[0]
  return longest ? longest.slice(0, 500) : undefined
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
        const line = source.slice(0, match.index).split('\n').length
        const message = messageAt(source, match.index + code.length)
        const held =
          found.get(code) ?? ({ code, package: pkg, sites: [], message: '', spec: [] } as ErrorCode)
        held.sites.push({ file: rel, line, ...(message ? { message } : {}) })
        if (message && message.length > held.message.length) held.message = message
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
