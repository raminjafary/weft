import { errorByCode, errorCodes, errorsByPackage } from './errors.ts'
import { escapeHtml, note, prose, table } from './markup.ts'

const REPO = 'https://github.com/raminjafary/weft/blob/main'

function link(code: string): string {
  return `<a href="/errors/${encodeURIComponent(code)}"><code>${escapeHtml(code)}</code></a>`
}

export function errorsIndexBody(): string {
  const all = errorCodes()
  const prose_ = all.filter((entry) => entry.detail === 'prose').length
  const wrapped = all.filter((entry) => entry.detail === 'wrapped').length
  const silent = all.length - prose_ - wrapped
  const withSpec = all.filter((entry) => entry.spec.length).length

  return (
    prose(
      `Every named refusal in the framework: <strong>${all.length}</strong> codes, extracted from the ` +
        'source that raises them.',
      'This framework refuses by name rather than by falling back. A capability that does not exist, a ' +
        'declaration that contradicts a derivation, a read the compiler cannot put in a cache key — each of ' +
        'those has a code and a sentence, and the sentence was written for whoever hit it. So this page is ' +
        'not prose about the codes; it is the codes, their messages, and the file that raises each one.',
    ) +
    note(
      'why',
      'Why it is extracted rather than written',
      `A reference of this size cannot be maintained by hand — one of the ${all.length} would go stale in ` +
        'the first month and there would be no way to tell which. So the page walks every package’s ' +
        '<code>src/</code>, and a test walks the same tree and fails if a code exists in the source and not ' +
        'here. Adding a refusal to the framework adds a row without anybody remembering to.',
    ) +
    table(
      ['Codes', 'Own sentence', 'Forwards a cause', 'Says nothing', 'With a spec reference'],
      [
        [
          String(all.length),
          `${prose_} <span class="hint">(${Math.round((prose_ / all.length) * 100)}%)</span>`,
          String(wrapped),
          String(silent),
          `${withSpec} <span class="hint">(${Math.round((withSpec / all.length) * 100)}%)</span>`,
        ],
      ],
    ) +
    note(
      'why',
      'Three states, because two would be a lie about one of them',
      `<strong>${prose_}</strong> codes carry a sentence of their own. <strong>${wrapped}</strong> forward ` +
        'the failure underneath instead — a parse error, a region that would not answer — and at runtime ' +
        'they do say something; it is the cause’s sentence rather than one in the source, so there is ' +
        'nothing here to quote. Calling those bare would be a complaint about this extractor dressed as a ' +
        `complaint about the framework. <strong>${silent}</strong> say nothing at all, and that is the ` +
        'number worth watching: the test fails if it rises above zero.',
    ) +
    errorsByPackage()
      .map(
        (group) =>
          `<h2 id="p-${escapeHtml(group.package)}"><a class="anchor" href="#p-${escapeHtml(
            group.package,
          )}">${escapeHtml(group.package)}</a> <span class="count">${group.codes.length}</span></h2>` +
          `<div class="scroll"><table><thead><tr><th>Code</th><th>What it means</th></tr></thead><tbody>${group.codes
            .map(
              (entry) =>
                `<tr><td>${link(entry.code)}</td><td>${
                  entry.message
                    ? escapeHtml(entry.message)
                    : entry.detail === 'wrapped'
                      ? '<span class="hint">forwards the underlying failure</span>'
                      : '<span class="hint undocumented">raised with no message</span>'
                }</td></tr>`,
            )
            .join('')}</tbody></table></div>`,
      )
      .join('')
  )
}

export function errorBody(code: string): string {
  const entry = errorByCode(code)
  if (!entry) {
    return `<div class="card"><h3>No such code</h3>
      <p><code>${escapeHtml(code)}</code> is not raised anywhere in this repository’s
      <code>packages/*/src</code>. If you saw it, it came from an older version — the
      <a href="/errors">index</a> is generated from the tree this site was built from.</p></div>`
  }
  return (
    `<p class="kind">${escapeHtml(entry.package)}</p>` +
    (entry.message
      ? `<blockquote class="message">${escapeHtml(entry.message)}</blockquote>` +
        prose(
          'That is the message as the source writes it, with interpolations shown as an ellipsis. It is a ' +
            'reconstruction of the template, not a capture of a runtime string.',
        )
      : note(
          'careful',
          entry.detail === 'wrapped' ? 'Forwards the failure underneath it' : 'Raised with no message',
          entry.detail === 'wrapped'
            ? 'This code carries whatever went wrong beneath it — a parse error, a region that would not ' +
                'answer — so at runtime it does say something. What it says is the cause’s sentence rather ' +
                'than one written in the source, which is why there is none to quote here.'
            : 'This code is thrown with nothing but itself. The file below is the only explanation there ' +
                'is, and that is a gap in the framework rather than in this page.',
        )) +
    `<h2>Where it is raised</h2>` +
    table(
      ['File', 'Line'],
      entry.sites.map((site) => [
        `<a href="${REPO}/${escapeHtml(site.file)}"><code>${escapeHtml(site.file)}</code></a>`,
        String(site.line),
      ]),
    ) +
    (entry.spec.length
      ? `<h2>The argument for it</h2>` +
        prose(
          'A code is a string; the reason it exists is a paragraph. These specification documents mention it:',
        ) +
        `<ul class="contents">${entry.spec
          .map((doc) => `<li><a href="${REPO}/${escapeHtml(doc)}"><code>${escapeHtml(doc)}</code></a></li>`)
          .join('')}</ul>`
      : `<p class="hint">No specification document mentions this code. What it means is the message and the file above.</p>`)
  )
}

/** Every code, for the route's declared params. */
export function codeIds(): string[] {
  return errorCodes().map((entry) => entry.code)
}
