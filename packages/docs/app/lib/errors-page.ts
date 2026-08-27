import type { Block } from '../fragments/docs/page.tsx'
import { bespoke, cell, heading, note, prose, table } from './blocks.ts'
import { errorByCode, errorCodes, errorsByPackage, type ErrorCode } from './errors.ts'
import { PAGES } from './pages.ts'
import { escapeHtml } from './escape.ts'

const REPO = 'https://github.com/raminjafary/weft/blob/main'

/**
 * The error reference, as blocks.
 *
 * This is the page the conversion was worth doing for. It prints 328 codes, their messages and the
 * files that raise them, every one extracted from `packages/* /src` rather than written — so every
 * cell is data, and every cell used to be a string this file assembled and escaped by hand. A `link()`
 * helper existed here for exactly that, wrapping a code in an `<a>` and a `<code>` and remembering
 * `escapeHtml`. The cell constructors replaced it and the compiler does the escaping.
 */
export function errorsIndexBody(): Block[] {
  const all = errorCodes()
  const own = all.filter((entry) => entry.detail === 'prose').length
  const wrapped = all.filter((entry) => entry.detail === 'wrapped').length
  const silent = all.length - own - wrapped
  const withSpec = all.filter((entry) => entry.spec.length).length
  const percent = (n: number) => `${Math.round((n / all.length) * 100)}%`

  const blocks: Block[] = [
    prose(
      `Every named refusal in the framework: <strong>${all.length}</strong> codes, extracted from the ` +
        'source that raises them.',
      'This framework refuses by name rather than by falling back. A capability that does not exist, a ' +
        'declaration that contradicts a derivation, a read the compiler cannot put in a cache key — each ' +
        'of those has a code and a sentence, and the sentence was written for whoever hit it. So this ' +
        'page is not prose about the codes; it is the codes, their messages, and the file that raises ' +
        'each one.',
    ),
    note(
      'why',
      'Why it is extracted rather than written',
      `A reference of this size cannot be maintained by hand — one of the ${all.length} would go stale ` +
        'in the first month and there would be no way to tell which. So the page walks every package’s ' +
        'src/ directory, and a test walks the same tree and fails if a code exists in the source and ' +
        'not here. Adding a refusal to the framework adds a row without anybody remembering to.',
    ),
    table(
      ['Codes', 'Own sentence', 'Forwards a cause', 'Says nothing', 'With a spec reference'],
      [
        [
          cell.text(String(all.length)),
          cell.text(`${own} (${percent(own)})`),
          cell.text(String(wrapped)),
          cell.text(String(silent)),
          cell.text(`${withSpec} (${percent(withSpec)})`),
        ],
      ],
    ),
    note(
      'why',
      'Three states, because two would be a lie about one of them',
      // Plain text, deliberately. A note's body is a hole in `fragments/docs/note.tsx`, so the
      // compiler escapes it — which is the whole reason it was made a hole, and means markup written
      // here would reach the reader as `<strong>` in the middle of a sentence.
      `${own} codes carry a sentence of their own. ${wrapped} forward the failure underneath instead ` +
        '— a parse error, a region that would not answer — and at runtime they do say something; it is ' +
        'the cause’s sentence rather than one in the source, so there is nothing here to quote. Calling ' +
        `those bare would be a complaint about this extractor dressed as a complaint about the ` +
        `framework. ${silent} say nothing at all, and that is the number worth watching: the test ` +
        'fails if it rises above zero.',
    ),
  ]

  for (const group of errorsByPackage()) {
    // Still bespoke: the outline column links to `#p-<package>`, so the id and the count live here
    // rather than in a heading block that has no room for either.
    blocks.push(
      bespoke(
        `<h2 id="p-${escapeHtml(group.package)}"><a class="anchor" href="#p-${escapeHtml(group.package)}">` +
          `${escapeHtml(group.package)}</a> <span class="count">${group.codes.length}</span></h2>`,
      ),
    )
    blocks.push(
      table(
        ['Code', 'What it means'],
        group.codes.map((entry) => [
          cell.codeLink(entry.code, `/errors/${encodeURIComponent(entry.code)}`),
          entry.message
            ? cell.text(entry.message)
            : entry.detail === 'wrapped'
              ? cell.hint('forwards the underlying failure')
              : cell.hint('raised with no message'),
        ]),
      ),
    )
  }

  return blocks
}

export function errorBody(code: string): Block[] {
  const entry = errorByCode(code)
  if (!entry) {
    return [
      bespoke(
        `<div class="card"><h3>No such code</h3><p><code>${escapeHtml(code)}</code> is not raised ` +
          'anywhere in this repository’s <code>packages/*/src</code>. If you saw it, it came from an ' +
          'older version — the <a href="/errors">index</a> is generated from the tree this site was ' +
          'built from.</p></div>',
      ),
    ]
  }

  const blocks: Block[] = [bespoke(`<p class="kind">${escapeHtml(entry.package)}</p>`)]

  if (entry.message) {
    blocks.push(bespoke(`<blockquote class="message refusal">${escapeHtml(entry.message)}</blockquote>`))
    blocks.push(
      prose(
        'That is the message as the source writes it, with interpolations shown as an ellipsis. It is a ' +
          'reconstruction of the template, not a capture of a runtime string.',
      ),
    )
  } else {
    blocks.push(
      note(
        'careful',
        entry.detail === 'wrapped' ? 'Forwards the failure underneath it' : 'Raised with no message',
        entry.detail === 'wrapped'
          ? 'This code carries whatever went wrong beneath it — a parse error, a region that would not ' +
              'answer — so at runtime it does say something. What it says is the cause’s sentence rather ' +
              'than one written in the source, which is why there is none to quote here.'
          : 'This code is thrown with nothing but itself. The file below is the only explanation there ' +
              'is, and that is a gap in the framework rather than in this page.',
      ),
    )
  }

  blocks.push(heading('Where it is raised', 'raised'))
  blocks.push(
    table(
      ['File', 'Line'],
      entry.sites.map((site) => [
        cell.codeLink(site.file, `${REPO}/${site.file}`),
        cell.text(String(site.line)),
      ]),
    ),
  )

  const introduces = introducedBy(entry)
  if (introduces.length) {
    blocks.push(heading('Introduced by', 'introduced'))
    blocks.push(
      prose(
        'A refusal makes sense once you know the mechanism it protects. These guide pages are the ' +
          'introduction to the documents this code is specified in:',
      ),
    )
    blocks.push(
      table(
        ['Guide page', 'What it covers'],
        introduces.map((page) => [cell.link(page.title, `/guide/${page.slug}`), cell.text(page.lede)]),
      ),
    )
  }

  const near = nearby(entry)
  if (near.length) {
    blocks.push(heading('Nearby refusals', 'nearby'))
    blocks.push(
      prose(
        'Raised in the same package, or specified in the same document. A refusal rarely stands on its ' +
          'own — the ones beside it are usually the same rule seen from another angle:',
      ),
    )
    blocks.push(
      table(
        ['Code', 'What it says', 'Raised in'],
        near.map((other) => [
          cell.codeLink(other.code, `/errors/${other.code}`),
          cell.text(other.message || '—'),
          cell.text(other.package),
        ]),
      ),
    )
  }

  if (entry.spec.length) {
    blocks.push(heading('The argument for it', 'argument'))
    blocks.push(
      prose(
        'A code is a string; the reason it exists is a paragraph. These specification documents mention it:',
      ),
    )
    blocks.push(
      table(
        ['Document'],
        entry.spec.map((doc) => [cell.codeLink(doc, `${REPO}/${doc}`)]),
      ),
    )
  } else {
    blocks.push(
      prose('No specification document mentions this code. What it means is the message and the file above.'),
    )
  }

  return blocks
}

/** Every code, for the route's declared params. */
export function codeIds(): string[] {
  return errorCodes().map((entry) => entry.code)
}

/**
 * The guide pages that introduce the mechanism this code protects.
 *
 * Matched through the spec documents: a page declares which ones it is the introduction to, and a
 * code carries which ones mention it. Where those two sets meet is a page a reader who has just hit
 * this refusal would actually want. No page names a code, and none should — that list would be the
 * one thing on this site nobody would remember to update.
 */
function introducedBy(entry: ErrorCode): { slug: string; title: string; lede: string }[] {
  if (!entry.spec.length) return []
  const specs = new Set(entry.spec.map(bare))
  return PAGES.filter((page) => page.covers.some((doc) => specs.has(bare(doc)))).map((page) => ({
    slug: page.slug,
    title: page.title,
    lede: page.lede,
  }))
}

/**
 * The same document, spelled the same way.
 *
 * A page names `kernel/cache.md` and a code carries `spec/kernel/cache.md`. Both are the same file;
 * only one of the two writes the directory it is already in.
 */
function bare(doc: string): string {
  return doc.replace(/^spec\//, '')
}

/** How many neighbours are worth listing. Five is a glance; the index is there for the rest. */
const NEARBY = 5

/**
 * The refusals beside this one.
 *
 * Sharing a specification document first, because that is the same argument seen from another
 * angle; then the same package, which is the same subsystem. Codes with their own sentence come
 * before ones without, since a neighbour that says nothing is not much of a neighbour.
 */
function nearby(entry: ErrorCode): ErrorCode[] {
  const others = errorCodes().filter((other) => other.code !== entry.code)
  const shares = (other: ErrorCode) => other.spec.some((doc) => entry.spec.includes(doc))
  const ranked = others
    .filter((other) => shares(other) || other.package === entry.package)
    .toSorted((a, b) => {
      const spec = Number(shares(b)) - Number(shares(a))
      if (spec) return spec
      return Number(Boolean(b.message)) - Number(Boolean(a.message))
    })
  return ranked.slice(0, NEARBY)
}
