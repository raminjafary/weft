import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The folder convention, read out of the walk that implements it.
 *
 * `convention.ts` opens with the whole convention as an aligned block — the same shape `weft --help`
 * keeps, and for the same reason: it is meant to be read by whoever is about to change the code
 * under it. So this parses the first one rather than the site keeping a second copy, and a path the
 * discovery stops recognising stops appearing on the page in the same commit.
 *
 * The sentences between the rows are kept too. One of them is the rule that a route is a `.tsx`
 * *or* a `.data.ts`, which is the single most surprising thing about the convention and would be
 * lost by a parser that only took the aligned lines.
 */
export interface ConventionRow {
  /** `app/routes/[slug].tsx`, as written. */
  path: string
  what: string
}

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const SOURCE = 'packages/weft/src/convention.ts'

/** The opening block comment of the file that walks the folder. */
function block(): string {
  const source = readFileSync(join(ROOT, SOURCE), 'utf8')
  const start = source.indexOf('/**')
  const end = source.indexOf('*/', start)
  if (start < 0 || end < 0) throw new Error('E_DOCS_NO_CONVENTION: convention.ts opens with no comment')
  return source
    .slice(start + 3, end)
    .split('\n')
    .map((line) => line.replace(/^\s*\* ?/, '').trimEnd())
    .join('\n')
}

/**
 * `  app/routes/x.data.ts   what it is` — a path, some spaces, a sentence.
 *
 * The first token has to look like a path, and that is what separates a row from the prose between
 * the rows rather than the column of spaces: the longest path in the block is one character short of
 * the column, so it is followed by a single space and a run-of-two rule silently dropped it.
 */
const ROW = /^ {2}(\S*[/.]\S*)\s+(\S.*)$/

export function conventionRows(): ConventionRow[] {
  const out: ConventionRow[] = []
  for (const line of block().split('\n')) {
    const match = ROW.exec(line)
    if (!match) continue
    out.push({ path: match[1] as string, what: (match[2] as string).replace(/\.$/, '') })
  }
  return out
}

/**
 * The prose in the comment, minus the rows and minus the paragraph about why a convention exists.
 *
 * The first paragraph is the file's own reason for being and the page says that better in its own
 * words; what is worth carrying is the rule stated in the middle of the table, which is about the
 * convention rather than about the module.
 */
export function conventionNotes(): string[] {
  const paragraphs: string[] = []
  let current: string[] = []
  for (const line of block().split('\n')) {
    if (ROW.test(line)) {
      if (current.length) paragraphs.push(current.join(' '))
      current = []
      continue
    }
    if (!line.trim()) {
      if (current.length) paragraphs.push(current.join(' '))
      current = []
      continue
    }
    current.push(line.trim())
  }
  if (current.length) paragraphs.push(current.join(' '))
  // The first two are the file's title line and its argument for having a convention at all.
  return paragraphs.slice(2)
}

/** Which directory a path belongs under, for the groups the page draws. */
export function groupOfPath(path: string): string {
  if (path.startsWith('app/routes/')) return 'app/routes/'
  if (path.startsWith('app/layouts/')) return 'app/layouts/'
  if (path.startsWith('app/slots/')) return 'app/slots/'
  if (path.startsWith('app/fragments/')) return 'app/fragments/'
  if (path.startsWith('app/intents/')) return 'app/intents/'
  if (path.startsWith('app/renderables/')) return 'app/renderables/'
  return 'app/'
}

/**
 * What each directory is for, in one sentence, and where the rest of the answer is.
 *
 * The one hand-written thing on the page. The convention block says what a *path* means, one line
 * each, because that is what a walk needs to know. It does not say why there are two directories
 * that both hold fragments, or which of them a browser can name — and those are the questions
 * somebody looking at the tree for the first time actually has.
 */
export const DIRECTORIES: readonly { path: string; what: string }[] = [
  {
    path: 'app/',
    what:
      'The application. Everything the framework discovers is under here, and the directory itself is ' +
      'named by <a href="/reference/config#srcDir"><code>srcDir</code></a> if it should not be ' +
      '<code>app</code>.',
  },
  {
    path: 'app/routes/',
    what:
      'The route table. The file tree <em>is</em> the routes, and nothing downstream of this directory ' +
      'may add one — there is no router to register with. What a route may declare is ' +
      '<a href="/reference/route"><code>defineRoute</code></a>.',
  },
  {
    path: 'app/layouts/',
    what:
      'Alternate documents, chosen per route with <a href="/reference/route#layout"><code>layout</code></a>. ' +
      '<code>error.tsx</code> is the reserved one: it is the 404 and the 500, and without it the ' +
      'framework serves its own.',
  },
  {
    path: 'app/slots/',
    what:
      'A fragment that fills the layout hole of its own name on <em>every</em> route, so a header or a ' +
      'footer is written once. A route that declares the same slot name wins for that route.',
  },
  {
    path: 'app/fragments/',
    what:
      'Components. Referenced by name from a route’s ' +
      '<a href="/reference/route#slots"><code>slots</code></a>, and by name from another fragment. ' +
      'Being here does not make one reachable by a browser — that is the next directory.',
  },
  {
    path: 'app/intents/',
    what:
      'Mutations, and the only thing in the framework allowed to write. The manifest is generated from ' +
      'this directory, so an intent’s id is its module path and its export name and nothing else. See ' +
      '<a href="/reference/intent"><code>defineIntent</code></a>.',
  },
  {
    path: 'app/renderables/',
    what:
      'The catalogue: fragments a <em>browser</em> may ask for, by opaque id. A separate directory from ' +
      '<code>fragments/</code> because the set of things a client can name is a security boundary and it ' +
      'should be visible in the file tree. See ' +
      '<a href="/reference/renderable"><code>defineRenderable</code></a>.',
  },
]

/** The anchor for a directory heading, so the page and its outline cannot disagree about one. */
export function directoryAnchor(path: string): string {
  return `dir-${path.replaceAll('/', '-').replace(/-$/, '')}`
}
