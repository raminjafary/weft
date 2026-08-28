import { escapeHtml, heading, note, prose, table } from './markup.ts'
import { strip } from './figures.ts'
import { errorCodes } from './errors.ts'
import { specifiedIn } from './specified.ts'
import { ceilingFor } from './budgets.ts'
import { onThisPage } from './rails.ts'
import { moduleById, surface, type ApiEntry, type ApiModule } from './surface.ts'
import { highlight } from './highlight.ts'

const KIND_ORDER: Record<string, number> = { function: 0, class: 1, interface: 2, type: 3, enum: 4, const: 5 }
const KIND_LABEL: Record<string, string> = {
  function: 'Functions',
  class: 'Classes',
  interface: 'Interfaces',
  type: 'Types',
  enum: 'Enums',
  const: 'Constants',
  unknown: 'Other',
}

const REPO = 'https://github.com/raminjafary/weft/blob/main'

function anchor(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()
}

/**
 * Which named refusals are raised in a given file.
 *
 * Built once from the error registry, which has already walked every package source tree for them. A file
 * is a coarse unit — an export's file may raise a code some *other* export in it throws — so the
 * page says "raised in this file" rather than "raised by this function", which is what the data
 * actually supports.
 */
let raisedIn: Map<string, string[]> | undefined

function raises(file: string): string[] {
  if (!raisedIn) {
    raisedIn = new Map()
    for (const code of errorCodes()) {
      for (const site of code.sites) {
        const found = raisedIn.get(site.file) ?? []
        if (!found.includes(code.code)) found.push(code.code)
        raisedIn.set(site.file, found)
      }
    }
  }
  return raisedIn.get(file) ?? []
}

function entry(item: ApiEntry): string {
  const refusals = raises(item.file)
  const specified = specifiedIn(item.name)
  return `<section class="api-entry" id="${anchor(item.name)}">
  <h3><a class="anchor" href="#${anchor(item.name)}"><code>${escapeHtml(item.name)}</code></a>
    <span class="kind">${escapeHtml(item.kind)}</span></h3>
  <figure class="code"><pre><code data-lang="ts">${highlight('ts', item.signature)}</code></pre></figure>
  ${
    item.doc
      ? `<div class="api-doc">${item.doc
          .split(/\n\s*\n/)
          .map((paragraph) => `<p>${inline(paragraph)}</p>`)
          .join('')}</div>`
      : `<p class="hint undocumented">No doc comment on the declaration. The signature and the file are all this page can honestly show.</p>`
  }
  ${
    refusals.length
      ? `<p class="api-raises"><span class="api-raises-kind">Raised in this file</span>${refusals
          .map((code) => `<a href="/errors/${escapeHtml(code)}"><code>${escapeHtml(code)}</code></a>`)
          .join('<span class="api-dot">·</span>')}</p>`
      : ''
  }
  ${
    specified.length
      ? `<p class="api-raises"><span class="api-raises-kind">Specified in</span>${specified
          .map((doc) => `<a href="${REPO}/${escapeHtml(doc)}"><code>${escapeHtml(doc)}</code></a>`)
          .join('<span class="api-dot">·</span>')}</p>`
      : ''
  }
  <p class="hint"><a href="${REPO}/${escapeHtml(item.file)}"><code>${escapeHtml(item.file)}</code></a></p>
</section>`
}

/** Backticks become code, and nothing else is interpreted. A doc comment is prose, not markdown. */
function inline(text: string): string {
  return escapeHtml(text.replace(/\s+/g, ' ')).replace(/`([^`]+)`/g, '<code>$1</code>')
}

function coverage(module: ApiModule): { documented: number; total: number } {
  return {
    documented: module.entries.filter((item) => item.doc).length,
    total: module.entries.length,
  }
}

export function moduleBody(id: string): string {
  const module = moduleById(id)
  if (!module) {
    return `<div class="card"><h3>No such module</h3><p>Known: ${surface()
      .map((m) => `<a href="/api/${m.id}"><code>${escapeHtml(m.specifier)}</code></a>`)
      .join(', ')}</p></div>`
  }
  const { documented, total } = coverage(module)
  const groups = [...new Set(module.entries.map((e) => e.kind))].sort(
    (a, b) => (KIND_ORDER[a] ?? 9) - (KIND_ORDER[b] ?? 9),
  )

  /**
   * What the build gates this package at, where it gates it at all.
   *
   * Only two packages have byte budgets — the client, which a browser downloads, and the kernel,
   * which a deployment does. The other seven have none, and say nothing rather than a zero. The
   * ceiling shown is the tightest of the package's entries, because that is the one a deployment
   * pays at minimum; the measured figure is not here, because `pnpm bench budget` computes it with
   * a bundler and prints it, and a page that shelled out to that would take twenty seconds to render.
   */
  const ceiling = ceilingFor(module.specifier)

  const brotli = ceiling?.brotli === undefined ? undefined : `${ceiling.brotli.toLocaleString('en-US')} B`

  return (
    strip(
      [
        { value: String(total), note: 'exports' },
        {
          value: String(documented),
          note: 'with a doc comment on the declaration',
          lit: documented === total,
        },
        ...(ceiling
          ? [
              {
                value: brotli ?? `${ceiling.limit.toLocaleString('en-US')} B`,
                note: brotli
                  ? `brotli, against a ${ceiling.limit.toLocaleString('en-US')} ceiling`
                  : `the tightest ceiling of ${ceiling.entries} gated ${
                      ceiling.entries === 1 ? 'entry' : 'entries'
                    }`,
              },
            ]
          : []),
      ],
      `Read out of <code>${escapeHtml(module.entry)}</code>, the package’s public entry, so this page ` +
        'is the surface itself rather than a description of it.',
    ) +
    // A filter for the eye rather than a control: the sections are on the page, and a chip is the
    // way to the one you want without scrolling past the two you do not.
    `<nav class="chips" aria-label="What is in this module">` +
    `<span class="chip" aria-current="true">All ${total}</span>` +
    groups
      .map(
        (kind) =>
          `<a class="chip" href="#k-${escapeHtml(kind)}">${escapeHtml(KIND_LABEL[kind] ?? kind)} ${
            module.entries.filter((item) => item.kind === kind).length
          }</a>`,
      )
      .join('') +
    `</nav>` +
    groups
      .map((kind) => {
        const of = module.entries.filter((item) => item.kind === kind)
        // The count is in the heading because a reader scanning a 318-export module wants to know
        // how far the section runs before deciding to read it.
        // The count sits beside the heading rather than inside it: `heading` escapes its text,
        // which is the property that makes it safe to hand any string, and worth keeping.
        return (
          `<div class="api-group">${heading(KIND_LABEL[kind] ?? kind, `k-${kind}`)}` +
          `<span class="api-count">${of.length}</span></div>` +
          of.map(entry).join('')
        )
      })
      .join('')
  )
}

export function apiIndexBody(): string {
  const total = surface().reduce((sum, m) => sum + m.entries.length, 0)
  const documented = surface().reduce((sum, m) => sum + coverage(m).documented, 0)
  return (
    strip(
      [
        { value: total.toLocaleString('en-US'), note: 'importable names' },
        { value: String(surface().length), note: 'entry points they are spread across' },
        {
          value: documented.toLocaleString('en-US'),
          note: 'with a doc comment on the declaration',
          lit: documented === total,
        },
      ],
      'Walked out of each package’s public entry and its re-exports, so adding an export adds a row ' +
        'and there is no second copy of the surface to keep in agreement with the first.',
    ) +
    prose(
      '<code>weft</code> is much the largest because it is the front door: it re-exports the adapters, the ' +
        'kernel types and the plan types an application needs, so what you can import from it is what is ' +
        'listed under it. The same declaration therefore appears under both <code>weft</code> and the ' +
        'package it lives in, which is the truth about the import rather than a duplicate.',
    ) +
    note(
      'why',
      documented === total
        ? 'Both numbers are checked, and they are the same number'
        : `Why "${total} exports, ${documented} documented" is on the page rather than hidden`,
      documented === total
        ? 'Two tests hold this page: one walks the packages and fails if an export is missing here, and one ' +
            'fails if an export has no doc comment on its declaration. It was 384 of 1,367 when the page was ' +
            'first published — the ratio was printed rather than hidden, because a blank space a reader ' +
            'mistakes for a simple function is worse than an admission. Printing it is what made it worth ' +
            'closing.'
        : 'Coverage of the <em>surface</em> is complete and checked: a test walks the same tree and fails if ' +
            'any export is missing here. Coverage of the <em>prose</em> is not, and the honest thing is to ' +
            'publish the ratio and mark every entry that has none, rather than let a reader assume a blank ' +
            'space is a simple function.',
    ) +
    table(
      ['Module', 'Import as', 'Exports', 'With a doc comment'],
      surface().map((module) => {
        const { documented: n, total: t } = coverage(module)
        return [
          `<a href="/api/${module.id}">${escapeHtml(module.title)}</a>`,
          `<code>${escapeHtml(module.specifier)}</code>`,
          String(t),
          `${n} <span class="hint">(${Math.round((n / Math.max(1, t)) * 100)}%)</span>`,
        ]
      }),
    )
  )
}

/**
 * The module's rail: the first names on the page, and how many more there are.
 *
 * Capped, because a 282-entry outline is not something anybody scrolls — the ⌘K panel is the way to
 * a name you already know, and this column is for seeing what kind of module you are in. The number
 * it stops at is stated rather than silently truncated.
 *
 * It used to open with a card repeating the specifier, the entry, the export count and the
 * documented count. Three of those four are the strip at the top of the article now, and the fourth
 * is in the sentence beside it, so the card was the same page twice in two columns.
 */
export function moduleOutline(id: string): string {
  const module = moduleById(id)
  if (!module) return ''
  const SHOWN = 24
  const shown = module.entries.slice(0, SHOWN)
  return (
    onThisPage(
      shown.map((item, at) => ({ label: item.name, href: `#${anchor(item.name)}`, current: at === 0 })),
      'In this module',
    ) +
    (module.entries.length > shown.length
      ? `<p class="hint">…and ${module.entries.length - shown.length} more on this page. ⌘K finds a name directly.</p>`
      : '')
  )
}

/** Every module id, for the route's declared params — which is what makes these pages files. */
export function moduleIds(): string[] {
  return surface().map((module) => module.id)
}
