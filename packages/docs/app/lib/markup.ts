import type { RenderedExample } from './example.ts'
import { escapeHtml } from './escape.ts'
import { highlight } from './highlight.ts'

// Re-exported because most of the site imports it from here, and where it is defined is not
// something twenty call sites should have to care about. See `escape.ts` for why it moved.
export { escapeHtml }

/**
 * Prose, as one paragraph per string.
 *
 * Deliberately not a markdown renderer. A documentation site that shipped one would be shipping a
 * parser whose output nothing checks, and the thing worth checking here is the examples. Inline
 * `<code>` and links are written as HTML where a sentence needs them, which is the same freedom
 * this repository's specs have.
 */
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
 * An example, as the page shows it: the file, what it rendered, and what the compiler knows.
 *
 * The three panels are one fragment's, which is the property the site is built on — so the caption
 * names the file and the facts table is the same sealed template the output came from. A reader who
 * doubts any of it can open the file at that path.
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

  return `<section class="example">
  <h3>${escapeHtml(rendered.title)}</h3>
  <p>${rendered.shows}</p>
  <figure class="code">
    <figcaption><code>${escapeHtml(rendered.file)}</code> — compiled by this application</figcaption>
    <pre><code data-lang="tsx">${highlight('tsx', rendered.source.trim())}</code></pre>
  </figure>
  <figure class="output">
    <figcaption>Rendered, from the template that file produced</figcaption>
    <div class="output-frame" data-example="${escapeHtml(rendered.id)}">${rendered.html}</div>
  </figure>${rendered.adopt ?? ''}
  <details class="facts">
    <summary>What the compiler knows about it</summary>
    <dl class="prov">
      <dt>Sealed templates</dt><dd>${rendered.facts.templates}</dd>
      <dt>Version</dt><dd><code>${escapeHtml(rendered.facts.version)}</code></dd>
      <dt>Reads</dt><dd>${
        rendered.facts.reads.length
          ? rendered.facts.reads.map((r) => `<code>${escapeHtml(r)}</code>`).join(', ')
          : '<em>nothing — so its class is static and its key is its content address</em>'
      }</dd>
      <dt>Wire forms</dt><dd>${rendered.facts.forms.map((f) => `<code>${escapeHtml(f)}</code>`).join(', ')}</dd>
      ${derived}
    </dl>
    <h4>Holes</h4>
    ${holes}
    <h4>What the client wires on adoption</h4>
    ${wiring}
    ${state}
  </details>
  ${rendered.note ? `<p class="hint">${rendered.note}</p>` : ''}
</section>`
}

/** Markup, as it arrived, for a hole whose content is already markup. */
export function raw(html: string): string {
  return html
}
