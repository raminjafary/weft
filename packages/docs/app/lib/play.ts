import { compileFiles } from '@weft/compiler'
import { render, stringify, type TemplateIR, type Values } from '@weft/ir'
import { escapeHtml, note, prose } from './markup.ts'

/**
 * The playground: compile what somebody typed.
 *
 * This is the one thing on the site that genuinely needed a virtual file set. Every example in the
 * guide is a real file, because a real file is type-checked and compiled by the build — but source
 * that arrives with a request has no directory behind it, and writing it to a temporary one to
 * compile it would make the result depend on where the process happened to be running.
 * `compileFiles({ sources })` takes the file set in memory instead.
 *
 * **Nothing here evaluates the source.** The compiler parses and lowers it; a sealed template is
 * data, and rendering one walks that data. A derived expression is an expression *tree* the renderer
 * interprets, not code it runs. So the worst a submission can do is be large, which is what the
 * size cap below is for.
 */
const MAX_BYTES = 8 * 1024

export const STARTER = `import { fragment } from 'weft'

export default fragment(({ name, count }: { name: string; count: number }) => (
  <article class="card">
    <h3>{name}</h3>
    <p>{count} in stock</p>
  </article>
))
`

export interface Compiled {
  ok: true
  /** The sealed template, as the wire would carry it. */
  ir: string
  html: string
  version: string
  templates: number
  holes: { binding: string; kind: string; escape: string }[]
  reads: string[]
  forms: string[]
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
    return {
      ok: true,
      ir: stringify(fragment.entry),
      html: decoder.decode(render(fragment.entry, values, (v) => byVersion.get(v))),
      version: fragment.entry.version,
      templates: fragment.templates.length,
      holes: fragment.entry.holes.map((hole) => ({
        binding: hole.binding,
        kind: hole.kind,
        escape: hole.escape,
      })),
      reads: [...fragment.entry.effects.reads],
      forms: [...fragment.entry.forms],
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code = /^(E_[A-Z_]+)/.exec(message)?.[1] ?? 'E_COMPILE'
    return { ok: false, code, message }
  }
}

export function playBody(source: string, outcome: Outcome | null): string {
  const form = `<form class="play" method="get" action="/play">
    <label for="src">A fragment module</label>
    <textarea id="src" name="src" rows="14" spellcheck="false">${escapeHtml(source)}</textarea>
    <div class="play-actions">
      <button type="submit">compile</button>
      <a class="reset" href="/play">reset</a>
    </div>
  </form>`

  const result = !outcome
    ? ''
    : outcome.ok
      ? `<h2>What it compiled to</h2>
        <figure class="output"><figcaption>Rendered, with a value invented per hole</figcaption>
          <div class="output-frame">${outcome.html}</div></figure>
        <dl class="prov">
          <dt>Sealed templates</dt><dd>${outcome.templates}</dd>
          <dt>Version</dt><dd><code>${escapeHtml(outcome.version)}</code></dd>
          <dt>Reads</dt><dd>${
            outcome.reads.length
              ? outcome.reads.map((r) => `<code>${escapeHtml(r)}</code>`).join(', ')
              : '<em>nothing</em>'
          }</dd>
          <dt>Wire forms</dt><dd>${outcome.forms.map((f) => `<code>${escapeHtml(f)}</code>`).join(', ')}</dd>
        </dl>
        <div class="scroll"><table><thead><tr><th>Binding</th><th>Hole</th><th>Escape</th></tr></thead><tbody>${outcome.holes
          .map(
            (hole) =>
              `<tr><td><code>${escapeHtml(hole.binding)}</code></td><td><code>${escapeHtml(
                hole.kind,
              )}</code></td><td><code>${escapeHtml(hole.escape)}</code></td></tr>`,
          )
          .join('')}</tbody></table></div>
        <details><summary>The sealed template, as the wire carries it</summary>
          <figure class="code"><pre><code data-lang="json">${escapeHtml(outcome.ir)}</code></pre></figure>
        </details>`
      : `<h2>Refused</h2><div class="card refusal">
          <h3><code>${escapeHtml(outcome.code)}</code></h3>
          <p>${escapeHtml(outcome.message)}</p>
        </div>
        <p class="hint">Every refusal has a name. <a href="/errors/${encodeURIComponent(
          outcome.code,
        )}">Look this one up →</a></p>`

  return (
    prose(
      'Type a fragment module and see what the compiler makes of it: the holes it lowered, how each one ' +
        'escapes, what it inferred the fragment reads, and the sealed template as the wire would carry it.',
    ) +
    form +
    result +
    note(
      'careful',
      'Every hole here escapes',
      'Escape elision is a type question, and the checker opens files through TypeScript’s own project ' +
        'system — which needs a directory. A virtual file set has none, so a fragment compiled here escapes ' +
        'every value rather than eliding by type. That is the safe direction, and it is why the elision ' +
        'example in the guide is a real file. <a href="/guide/fragments#escaping">See it there</a>.',
    ) +
    note(
      'why',
      'Nothing you type is executed',
      'The compiler parses and lowers; it never evaluates. A sealed template is data, and rendering one ' +
        'walks that data — even a derived value is an expression tree the renderer interprets rather than ' +
        'code it runs. The only resource a submission can spend is size, which is capped at 8 KB.',
    )
  )
}
