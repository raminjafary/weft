import { scopeAttribute, scopeCss } from '@weftjs/core/server'
import { fragmentIR } from '@weftjs/core'
import { escapeHtml, field, panel, pick, pre, press, readout } from '../pages.ts'
import type { StationHandler } from './kind.ts'

/**
 * Scoped stylesheets, taken apart. Shows the two halves that must agree without speaking to each
 * other: the attribute the compiler stamps into a template, and the one the asset build derives
 * from the sheet beside it. See `spec/compiler/scoped-styles.md`.
 */

/** Selectors worth seeing narrowed. Each is a case the transform has to get right. */
const SELECTORS = [
  '.row .cell',
  '.card:hover',
  '.card::after',
  '.a, .b',
  ':is(.a, .b) .c',
  "a[href^='/x'] .deep",
  '@media (max-width: 500px)',
  '@keyframes spin',
] as const

/** Fragments in this application, so the attribute belongs to a file you can open. */
const FRAGMENTS = ['card', 'panels', 'composed', 'identity'] as const

/** The selector as a stylesheet. The two at-rules become blocks, because that is what they are. */
function authored(selector: string): string {
  if (selector.startsWith('@media')) return `${selector} {\n  .card {\n    padding: 0;\n  }\n}\n`
  if (selector.startsWith('@keyframes')) return `${selector} {\n  0% {\n    opacity: 0;\n  }\n}\n`
  return `${selector} {\n  color: red;\n}\n`
}

/** How many elements the sealed template opens, counted off its own segments. */
function elementsIn(segments: readonly Uint8Array[]): number {
  const text = segments.map((segment) => new TextDecoder().decode(segment)).join('')
  return (text.match(/<[a-z][a-z0-9-]*[\s>/]/g) ?? []).length
}

export const scopedStyles: StationHandler = async (ctx) => {
  const selector = ctx.query('selector') ?? SELECTORS[0]
  const which = ctx.query('fragment') ?? FRAGMENTS[0]
  const target = fragmentIR(`fragment:${which}`)
  const stem = target.file.replace(/\.tsx$/, '')
  const name = stem.split('/').pop() ?? stem
  const attribute = scopeAttribute(stem)
  const source = authored(selector)
  const elements = elementsIn(target.entry.segments)

  return {
    panel: panel(
      [
        field('fragment', pick('scoped-fragment', [...FRAGMENTS], which)),
        field('selector', pick('scoped-selector', [...SELECTORS], selector)),
        press('scoped-go', 'narrow it'),
      ].join(''),
      'The attribute comes from the file path, not the contents — so editing a template or its sheet ' +
        'never changes it, and a cached stylesheet survives a typo fix.',
    ),
    body: async () =>
      [
        `<div class="card"><h3>${escapeHtml(target.file)}</h3>`,
        `<p class="hint">Its scope attribute, from <code>scopeAttribute()</code>:</p>`,
        pre(attribute),
        `<p class="hint">Name its sheet <code>${escapeHtml(name)}.scoped.css</code> and every one of the ` +
          `${elements} elements this template declares carries that attribute — written into the sealed ` +
          `bytes at build time, so nothing runs in the browser to put it there.</p></div>`,
        `<div class="card"><h3>As authored</h3>${pre(source)}`,
        `<h3>As served</h3>${pre(scopeCss(source, attribute))}`,
        `<p class="hint">The attribute joins the last compound selector, before any pseudo: an ancestor ` +
          `may be anywhere, the element being styled may not. <code>@media</code> recurses; ` +
          `<code>@keyframes</code> does not, because its percentages are not selectors.</p></div>`,
      ].join(''),
    readout: async () =>
      readout(
        'What the scope reaches',
        [
          {
            label: 'Elements this fragment declares',
            value: String(elements),
            note: 'every one carries the attribute',
          },
          { label: 'Runtime cost', value: '0 ms', note: 'the compiler wrote it; nothing hydrates' },
          {
            label: 'Wire cost',
            value: `${attribute.length + 1} B per element`,
            note: 'the attribute, and the space before it',
          },
          {
            label: 'Reaches a composed child',
            value: 'no',
            note: 'a <Card/> is its own sealed template, with its own scope',
          },
        ],
        {
          what: 'The attribute stamped on this fragment, and one selector narrowed to it. Both from the functions the build itself calls.',
          from: 'weft/server — scopeAttribute() and scopeCss()',
          caveat:
            'There is no :deep(), and @keyframes names are not rewritten. Both are in spec/compiler/scoped-styles.md with the argument.',
          tryThis: 'Switch the selector to the pseudo-element and watch the attribute stay in front of it.',
        },
      ),
  }
}
