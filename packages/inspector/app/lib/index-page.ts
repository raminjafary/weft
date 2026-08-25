import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { escapeHtml, explain, panel } from './pages.ts'
import { GROUPS, STATIONS, type Station } from './stations.ts'

/**
 * The specs of the project being inspected, not of the inspector.
 *
 * Read from the working directory, because the coverage gate is a statement about *a* project: it
 * asks which of that project's spec documents have no station claiming them. Run somewhere with no
 * `spec/` and it says so rather than showing an empty table, which would read as full coverage.
 */
const SPEC = join(process.cwd(), 'spec')

export function hasSpecs(): boolean {
  return existsSync(SPEC)
}

/** Spec documents that describe the project rather than a capability, so they get no station. */
const META_SPECS = new Set(['FINDINGS.md', 'VERSIONING.md'])

export function specDocuments(): string[] {
  if (!hasSpecs()) return []
  const out: string[] = []
  for (const dir of readdirSync(SPEC, { withFileTypes: true })) {
    if (dir.isDirectory()) {
      for (const file of readdirSync(join(SPEC, dir.name))) {
        if (file.endsWith('.md')) out.push(`${dir.name}/${file}`)
      }
    } else if (dir.name.endsWith('.md') && !META_SPECS.has(dir.name)) {
      out.push(dir.name)
    }
  }
  return out.sort()
}

export function coverage(): { doc: string; stations: string[] }[] {
  return specDocuments().map((doc) => ({
    doc,
    stations: STATIONS.filter((s) => s.covers.includes(doc)).map((s) => s.id),
  }))
}

export function missingSpecFiles(): string[] {
  const known = new Set(specDocuments())
  const named = new Set(STATIONS.flatMap((s) => s.covers))
  if (!hasSpecs()) return []
  return [...named].filter((doc) => !known.has(doc) && !existsSync(join(SPEC, doc))).sort()
}

function card(href: string, title: string, status: string, detail: string): string {
  return `<a href="${href}"><span class="t">${escapeHtml(title)}<span class="status" data-status="${status}">${status}</span></span><span class="d">${escapeHtml(detail)}</span></a>`
}

export function indexBody(): string {
  const groups = GROUPS.map((group) => {
    const inGroup = STATIONS.filter((s) => s.group === group.id)
    if (!inGroup.length) return ''
    return `<h2>${group.label}</h2><div class="grid">${inGroup
      .map((s: Station) => card(`/s/${s.id}`, s.title, s.status, s.shows))
      .join('')}</div>`
  }).join('')

  const live = STATIONS.filter((s) => s.status === 'live').length
  const planned = STATIONS.filter((s) => s.status === 'planned').length
  const refused = STATIONS.filter((s) => s.status === 'refused').length

  return `
  ${groups}
  <h2>What these labels mean</h2>
  <div class="card coverage">
    <p><span class="status" data-status="live">live</span> the mechanism runs when you open the
    page. A test refuses to let a station claim this without a handler registered, so it cannot be
    aspirational. <strong>${live}</strong> stations.</p>
    <p><span class="status" data-status="planned">planned</span> the capability is built and
    measured; this page is not written yet. <strong>${planned}</strong> stations.</p>
    <p><span class="status" data-status="refused">refused</span> the capability does not exist. The
    page says so rather than mocking it — better an honest empty station than a mock.
    <strong>${refused}</strong> stations.</p>
    <p class="hint">Every station names the spec documents it is the live version of, and
    <a href="/spec">the coverage page</a> fails the build if a spec document has no station. That
    is what makes “not a subset” a promise rather than a claim.</p>
  </div>`
}

export function coverageBody(): string {
  if (!hasSpecs()) {
    return `<div class="card"><h3>No specs here</h3>
      <p>This page asks which of a project's spec documents have no station claiming them. It reads
      <code>spec/</code> in the working directory, and there is not one — so there is nothing to
      report. An empty table would read as full coverage, which is the opposite of the truth.</p>
      <p class="hint">Run the inspector from a project with a <code>spec/</code> directory.</p></div>`
  }
  const rows = coverage()
  const body = rows
    .map(
      (row) =>
        `<div class="row" data-state="${row.stations.length ? 'within' : 'over'}"><dt>${row.doc}</dt><dd class="value">${row.stations.length}</dd><dd class="note">${
          row.stations.length
            ? row.stations.map((id) => `<a href="/s/${id}">${id}</a>`).join(', ')
            : '<span class="miss">no station</span>'
        }</dd></div>`,
    )
    .join('')
  return `
  ${panel('', 'This page is the gate in demo/test/stations.test.ts, rendered. If a row says “no station”, the build is red.')}
  <div class="card readout-table"><h3>Spec document → station</h3><dl>${body}</dl></div>
  ${explain({
    what: `Every capability in the specs has a station, and every station names the documents it covers. The count in the middle column is how many stations claim each document.`,
    from: 'coverage() in demo/src/index-page.ts, walking spec/ on disk',
    caveat:
      'It checks that a station exists and claims the document. It cannot check that the station is a good explanation of it.',
    tryThis: 'Add a spec document and reload: the row appears immediately, and the build goes red.',
  })}`
}
