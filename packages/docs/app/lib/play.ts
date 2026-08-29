import { compileFiles } from '@weftjs/compiler'
import { render, stringify, type TemplateIR, type Values } from '@weftjs/ir'
import { escapeHtml } from './escape.ts'
import { highlight } from './highlight.ts'
import { infer } from '../infer.ts'

/**
 * The playground: compile what somebody typed. The one thing on the site needing a virtual file
 * set — `compileFiles({ sources })` takes the file set in memory, since request-arriving source has
 * no real directory to compile against.
 *
 * Nothing here evaluates the source: the compiler parses and lowers it, a sealed template is data,
 * and a derived expression is a tree the renderer interprets, never code it runs. The worst a
 * submission can do is be large, which is what the size cap below is for.
 *
 * The right-hand panel is the compiler's authoritative answer, on submit. The block under the
 * editor is `infer.ts`'s browser-side hint, rendered here too from the same module so first paint
 * already has it.
 */
const MAX_BYTES = 8 * 1024

export const STARTER = `import { fragment } from '@weftjs/core'

interface Props { label: string; count: number }

export default fragment(({ label, count }: Props) => (
  <span class="pill">
    {label} <b>{count}</b>
  </span>
))
`

export interface Compiled {
  ok: true
  /** The sealed template, as the wire would carry it. */
  ir: string
  html: string
  version: string
  templates: number
  segments: number
  bytes: number
  holes: { binding: string; kind: string; escape: string }[]
  reads: string[]
  forms: string[]
  /** The pre-encoded byte runs between the holes, decoded for reading. */
  runs: string[]
}

export interface Refused {
  ok: false
  code: string
  message: string
}

export type Outcome = Compiled | Refused

const decoder = new TextDecoder()

/** Values for whatever holes the fragment turned out to have, so it renders rather than blanking. */
function valuesFor(entry: TemplateIR): Values {
  const values: Values = {}
  for (const hole of entry.holes) {
    if (hole.binding in values) continue
    values[hole.binding] =
      hole.kind === 'list' ? [{ name: 'one' }, { name: 'two' }] : hole.binding === 'count' ? 3 : hole.binding
  }
  return values
}

export async function compilePlayground(source: string): Promise<Outcome> {
  const trimmed = source.trim()
  if (!trimmed) return { ok: false, code: 'E_EMPTY', message: 'Nothing to compile.' }
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_BYTES) {
    return {
      ok: false,
      code: 'E_TOO_LARGE',
      message: `A submission is capped at ${MAX_BYTES} bytes. This one is ${Buffer.byteLength(trimmed, 'utf8')}.`,
    }
  }
  const file = 'play.tsx'
  const sources = new Map([[file, `${trimmed}\n`]])
  try {
    const out = await compileFiles([file], { sources, root: '.' })
    const fragment = out.modules[0]?.fragments[0]
    if (!fragment) {
      return {
        ok: false,
        code: 'E_NO_FRAGMENT',
        message: 'That module exports no fragment(). A fragment is a default-exported fragment() call.',
      }
    }
    const byVersion = new Map(fragment.templates.map((t) => [t.version, t]))
    const values = valuesFor(fragment.entry)
    const runs = fragment.entry.segments.map((segment) => decoder.decode(segment))
    return {
      ok: true,
      ir: stringify(fragment.entry),
      html: decoder.decode(render(fragment.entry, values, (v) => byVersion.get(v))),
      version: fragment.entry.version,
      templates: fragment.templates.length,
      segments: runs.length,
      bytes: runs.reduce((sum, run) => sum + Buffer.byteLength(run, 'utf8'), 0),
      holes: fragment.entry.holes.map((hole) => ({
        binding: hole.binding,
        kind: hole.kind,
        escape: hole.escape,
      })),
      reads: [...fragment.entry.effects.reads],
      forms: [...fragment.entry.forms],
      runs,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code = /^(E_[A-Z_]+)/.exec(message)?.[1] ?? 'E_COMPILE'
    return { ok: false, code, message }
  }
}

/* ── the page ─────────────────────────────────────────────────────────────── */

const enc = escapeHtml

/** One tab of the right-hand panel. Radio inputs and `:has`, like every other tab strip here. */
function tabs(panels: readonly { label: string; body: string }[]): string {
  return `<div class="pane-tabs">${panels
    .map(
      (panel, at) =>
        `<label class="pane-tab"><input type="radio" name="out" value="${enc(panel.label)}"${
          at === 0 ? ' checked' : ''
        }><span>${enc(panel.label)}</span></label>`,
    )
    .join('')}</div>${panels.map((panel) => `<section class="pane-panel">${panel.body}</section>`).join('')}`
}

function box(body: string): string {
  return `<div class="pane-box">${body}</div>`
}

function codeBox(lang: string, source: string): string {
  return box(`<pre><code data-lang="${enc(lang)}">${highlight(lang, source)}</code></pre>`)
}

/** The hint table, rendered on the server from the same module the browser re-runs per keystroke. */
export function hintTable(source: string): string {
  const { hints, reads, cacheClass, notes } = infer(source)
  const rows = hints.length
    ? hints
        .map(
          (hint) =>
            `<tr${hint.undeclared ? ' class="unknown"' : ''}><td><code>${enc(hint.binding)}</code></td>` +
            `<td><code>${enc(hint.type)}</code></td><td><code>${enc(hint.where)}</code></td>` +
            `<td><code>${enc(hint.escape)}</code></td><td class="hint">${hint.line}</td></tr>`,
        )
        .join('')
    : '<tr><td colspan="5" class="hint">No holes yet — every byte of this template would be constant.</td></tr>'
  return `<div class="scroll"><table>
      <thead><tr><th>Binding</th><th>Type</th><th>Hole</th><th>Escape</th><th>Line</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <dl class="prov"><div class="prov-row"><dt>Reads</dt><dd>${
      reads.length ? reads.map((read) => `<code>${enc(read.taint)}</code>`).join(' ') : '<em>nothing</em>'
    }</dd></div><div class="prov-row"><dt>Cache class</dt><dd><code>${cacheClass}</code></dd></div></dl>
    ${notes.map((note) => `<p class="hint">${enc(note)}</p>`).join('')}`
}

function result(outcome: Outcome | null): string {
  if (!outcome) {
    return (
      tabs([
        {
          label: 'Template IR',
          body: box(
            `<p class="pane-idle">Press <kbd>⌘↵</kbd> or <strong>Compile</strong>. The compiler runs over a
             file set held in memory — nothing is written anywhere, and the result has a URL you can share.</p>`,
          ),
        },
      ]) + ''
    )
  }
  if (!outcome.ok) {
    return (
      tabs([
        {
          label: 'Refused',
          body: box(`<pre class="refused"><code>${enc(outcome.message)}</code></pre>`),
        },
      ]) +
      `<div class="banner bad"><span class="banner-mark">✕</span><span><code>${enc(
        outcome.code,
      )}</code> — every refusal has a name and a page.
        <a href="/errors/${encodeURIComponent(outcome.code)}">Look this one up →</a></span></div>`
    )
  }

  const holes = outcome.holes.length
    ? `<div class="scroll"><table><thead><tr><th>Binding</th><th>Hole</th><th>Escape</th></tr></thead><tbody>${outcome.holes
        .map(
          (hole) =>
            `<tr><td><code>${enc(hole.binding)}</code></td><td><code>${enc(
              hole.kind,
            )}</code></td><td><code>${enc(hole.escape)}</code></td></tr>`,
        )
        .join('')}</tbody></table></div>`
    : '<p class="hint">No holes: every byte of this template is constant.</p>'

  const effects = box(
    `<dl class="prov">
      <div class="prov-row"><dt>Reads</dt><dd>${
        outcome.reads.length
          ? outcome.reads.map((read) => `<code>${enc(read)}</code>`).join(', ')
          : '<em>nothing — so its class is static and its key is its content address</em>'
      }</dd></div>
      <div class="prov-row"><dt>Wire forms</dt><dd>${outcome.forms
        .map((form) => `<code>${enc(form)}</code>`)
        .join(', ')}</dd></div>
      <div class="prov-row"><dt>Sealed templates</dt><dd>${outcome.templates}</dd></div>
      <div class="prov-row"><dt>Version</dt><dd><code>${enc(outcome.version)}</code></dd></div>
    </dl>${holes}`,
  )

  const segments = box(
    `<ol class="runs">${outcome.runs
      .map((run) => `<li><code>${enc(run) || '<span class="hint">·</span>'}</code></li>`)
      .join('')}</ol>
     <p class="hint">${outcome.segments} pre-encoded runs, ${outcome.bytes} bytes of constant markup. A
      render writes these straight out and fills the gaps between them; nothing here is built per request.</p>`,
  )

  return (
    tabs([
      { label: 'Template IR', body: codeBox('json', outcome.ir) },
      { label: 'Segments', body: segments },
      { label: 'Effects', body: effects },
      { label: 'Output', body: box(`<div class="pane-out">${outcome.html}</div>`) },
    ]) +
    `<div class="banner"><span class="banner-mark">✓</span><span>Compiled into ${
      outcome.templates
    } sealed template${outcome.templates === 1 ? '' : 's'}, ${outcome.holes.length} hole${
      outcome.holes.length === 1 ? '' : 's'
    }, ${outcome.segments} segments. The rendered output is the template filled with a value invented
      per hole.</span></div>`
  )
}

/**
 * The playground's body. `reset` carries `data-weft-scroll="preserve"` since it re-renders this
 * page with no source rather than navigating; compile needs no attribute, as `method="get"`
 * preserves by default.
 */
/**
 * How much source this page can carry. The source is a query parameter deliberately, so a compiled
 * result has a shareable URL and the page works with no runtime — but a URL has a length limit
 * enforced before the request arrives, and past it the reader once got the platform's own
 * unstyled error page. So the limit is stated at `maxlength`, which holds with JS off.
 *
 * The number: a 32 KB URL ceiling, minus a quarter reserved for origin/path/other params, divided
 * by three for percent-encoding's worst case (`<`, `>`, `/`, newlines are dense in a fragment).
 */
const URL_CEILING = 32_000
/** Room for the origin, the path, and whatever else the reader is carrying in the query. */
const URL_RESERVE = 8_000
export const SOURCE_MAX = Math.floor((URL_CEILING - URL_RESERVE) / 3)

export function playBody(source: string, outcome: Outcome | null): string {
  return `<form class="play" method="get" action="/play">
    <header class="play-head">
      <div>
        <h1>Playground</h1>
        <p class="lede">Type a fragment and see what it compiles to. Nothing is written anywhere — the
          compiler runs over a virtual file set, which is why this page is one of the two on this site
          that is not a file.</p>
      </div>
      <div class="play-do">
        <a class="btn" href="/play" data-weft-scroll="preserve">Reset</a>
        <button class="btn btn-primary" type="submit">Compile <kbd>⌘↵</kbd></button>
      </div>
    </header>

    <div class="play-panes">
      <section class="pane">
        <div class="pane-head">
          <span class="eyebrow">Fragment</span>
          <span class="pane-path">virtual:/play/fragment.tsx</span>
        </div>
        <div class="editor">
          <pre class="editor-hl" aria-hidden="true"><code>${highlight('tsx', `${source}\n`)}</code></pre>
          <textarea id="src" name="src" spellcheck="false" autocapitalize="off" autocomplete="off"
            autocorrect="off" maxlength="${SOURCE_MAX}"
            aria-label="A fragment module">${enc(source)}</textarea>
        </div>
        <div class="pane-head second">
          <span class="eyebrow">While you type</span>
          <span class="pane-path">a scan, not the compiler</span>
        </div>
        <div id="hints" class="hints">${hintTable(source)}</div>
      </section>

      <section class="pane">${result(outcome)}</section>
    </div>

    <footer class="play-foot">
      <span class="badge mute">not a file</span>
      <p>This route declares <code>static: false</code> with its reason: the page is a function of what
        you typed, and the compiler's virtual file set has no path on disk to address. The other one is
        search. Escape elision is a type question and a virtual file set has no directory for the
        checker to open, so every hole compiled here escapes — which is the safe direction, and why the
        elision example in the guide is a real file.
        <a href="/guide/fragments#escaping">See it there</a>.</p>
      <p>What you type travels in the URL, which is what makes a compiled result a link you can send
        and what lets this page work with JavaScript switched off. A URL has a length limit that
        belongs to the host rather than to this site, so the box stops at
        <strong>${SOURCE_MAX.toLocaleString('en-GB')} characters</strong> — about a hundred and sixty
        lines. It is the largest source that still fits once every <code>&lt;</code> and newline is
        percent-encoded and there is room left for the rest of the URL.</p>
    </footer>
  </form>`
}
