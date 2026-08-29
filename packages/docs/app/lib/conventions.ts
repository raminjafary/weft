import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The folder convention, read out of `convention.ts`'s own opening comment block rather than a
 * second copy — a path the discovery stops recognising stops appearing on the page in the same
 * commit. The prose between the rows is kept too, since it carries the convention's most
 * surprising rule (a route is `.tsx` *or* `.data.ts`).
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

/** `  app/routes/x.data.ts   what it is`. First token must look like a path — the column-of-spaces rule alone missed the longest path, one char short of the column. */
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

/** The prose in the comment, minus the rows and minus the opening paragraph (the file's own reason for being, which the page states better itself). */
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

/** What each directory is for. The one hand-written thing on the page — the convention block says what a *path* means, not why two directories both hold fragments. */
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
