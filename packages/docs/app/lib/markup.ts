import type { RenderedExample } from './example.ts'
import { escapeHtml } from './escape.ts'
import { highlight } from './highlight.ts'

// Re-exported because most of the site imports it from here, and where it is defined is not
// something twenty call sites should have to care about. See `escape.ts` for why it moved.
export { escapeHtml }

/** Prose, one paragraph per string. Deliberately not a markdown renderer — inline `<code>` and links are written as HTML directly, same freedom the specs have. */
export function prose(...paragraphs: string[]): string {
  return paragraphs.map((text) => `<p>${text}</p>`).join('')
}

export function heading(text: string, id: string): string {
  return `<h2 id="${escapeHtml(id)}"><a class="anchor" href="#${escapeHtml(id)}">${escapeHtml(text)}</a></h2>`
}

export function note(kind: 'why' | 'refused' | 'careful', title: string, body: string): string {
  return `<aside class="note note-${kind}"><h4>${escapeHtml(title)}</h4><p>${body}</p></aside>`
}

export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  return `<div class="scroll"><table><thead><tr>${headers
    .map((h) => `<th>${escapeHtml(h)}</th>`)
    .join('')}</tr></thead><tbody>${rows
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div>`
}

/** A code block that is only ever quoted text: a shape to imitate, never a claim that it ran. */
export function sketch(language: string, code: string): string {
  return `<figure class="code sketch"><figcaption>sketch — not compiled</figcaption><pre><code data-lang="${escapeHtml(
    language,
  )}">${highlight(language, code.trim())}</code></pre></figure>`
}

/**
 * An example, as the page shows it: what it rendered, the file, and what the compiler knows — all
 * three panels are one fragment's. Output and source sit side by side, not stacked, so a reader can
 * actually check that one compiled to the other without scrolling between them.
 */
export function example(rendered: RenderedExample): string {
  const holes = rendered.facts.holes.length
    ? table(
        ['Binding', 'Hole', 'Escape'],
        rendered.facts.holes.map((hole) => [
          `<code>${escapeHtml(hole.binding)}</code>`,
          `<code>${escapeHtml(hole.kind)}</code>`,
          `<code>${escapeHtml(hole.escape)}</code>`,
        ]),
      )
    : '<p class="hint">No holes: every byte of this template is constant.</p>'

  const wiring = rendered.facts.wiring.length
    ? table(
        ['Op', 'Binds', 'Where'],
        rendered.facts.wiring.map((wire) => [
          `<code>${escapeHtml(wire.op)}</code>`,
          `<code>${escapeHtml(wire.binding)}</code>`,
          `<code>${escapeHtml(wire.target)}</code>`,
        ]),
      )
    : '<p class="hint">No wiring: nothing on this template changes after it is painted, so the client attaches nothing to it.</p>'

  const state = rendered.facts.signals.length
    ? table(
        ['Signal', 'Type', 'Initial'],
        rendered.facts.signals.map((signal) => [
          `<code>${escapeHtml(signal.id)}</code>`,
          `<code>${escapeHtml(signal.type)}</code>`,
          `<code>${escapeHtml(signal.init)}</code>`,
        ]),
      )
    : ''

  const derived = rendered.facts.derived.length
    ? `<dt>Derived</dt><dd>${rendered.facts.derived
        .map((entry) => `<code>${escapeHtml(entry)}</code>`)
        .join(', ')}</dd>`
    : ''

  return `<section class="example" id="ex-${escapeHtml(anchorOf(rendered.id))}">
  <div class="example-head">
    <h3><a class="anchor" href="#ex-${escapeHtml(anchorOf(rendered.id))}">${escapeHtml(rendered.title)}</a></h3>
    <span class="example-of">${escapeHtml(rendered.id)}</span>
  </div>
  <p>${rendered.shows}</p>
  <div class="duo">
    <figure class="output">
      <figcaption>output</figcaption>
      <div class="output-frame" data-example="${escapeHtml(rendered.id)}">${rendered.html}</div>
    </figure>
    <figure class="code">
      <figcaption><code>${escapeHtml(rendered.file)}</code></figcaption>
      <pre><code data-lang="tsx">${highlight('tsx', rendered.source.trim())}</code></pre>
    </figure>
  </div>${rendered.adopt ?? ''}
  <details class="facts" open>
    <summary>What the compiler knows</summary>
    ${tiles(rendered)}
    <h4>Holes</h4>
    ${holes}
    <h4>What the client wires on adoption</h4>
    ${wiring}
    ${state}
    <dl class="prov">
      <dt>Sealed templates</dt><dd>${rendered.facts.templates}</dd>
      <dt>Version</dt><dd><code>${escapeHtml(rendered.facts.version)}</code></dd>
      ${derived}
    </dl>
  </details>
  ${rendered.note ? `<p class="hint">${rendered.note}</p>` : ''}
</section>`
}

/** The four numbers worth reading before the tables under them, all derived from the same sealed template — an empty effect set really does mean static. */
function tiles(rendered: RenderedExample): string {
  const { holes, reads, forms } = rendered.facts
  const elided = holes.filter((hole) => hole.escape === 'none').length
  const cells: { label: string; value: string; accent?: boolean }[] = [
    { label: 'Holes', value: String(holes.length) },
    { label: 'Escape elided', value: String(elided), accent: elided > 0 },
    { label: 'Effect set', value: reads.length ? reads.join(' · ') : 'none — static' },
    { label: 'Wire forms', value: forms.join(' · '), accent: true },
  ]
  return `<div class="tiles">${cells
    .map(
      (cell) =>
        `<div class="tile"><span>${escapeHtml(cell.label)}</span><b${
          cell.accent ? ' class="lit"' : ''
        }>${escapeHtml(cell.value)}</b></div>`,
    )
    .join('')}</div>`
}

/** `examples/badge` is one fragment, and `ex-examples-badge` is the place on the page it is at. */
function anchorOf(id: string): string {
  return id.replace(/[^A-Za-z0-9]+/g, '-')
}

/** Markup, as it arrived, for a hole whose content is already markup. */
export function raw(html: string): string {
  return html
}
