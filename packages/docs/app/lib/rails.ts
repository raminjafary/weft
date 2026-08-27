import { escapeHtml } from './escape.ts'

/**
 * The two things that go in an outline column, written once.
 *
 * Every section's right-hand rail is some arrangement of "the headings on this page" and "a small
 * card saying something true about this page". Six routes were each building both by hand, which is
 * six places for the markup to drift apart and six escapes to remember. They are values here and
 * markup in one place.
 *
 * The contents rail on the left is a sealed template — `fragments/docs/contents.tsx` — because it is
 * byte-identical across a whole section and therefore worth one cache entry. These are not: an
 * outline is different on every page, so a fragment would buy a template nothing reuses.
 */

export interface OutlineItem {
  label: string
  href: string
  /** The one the reader is at, or the first, which is what the accent bar marks. */
  current?: boolean
}

/** `On this page`: the headings, with the current one marked by its left edge. */
export function onThisPage(items: readonly OutlineItem[], heading = 'On this page'): string {
  if (!items.length) return ''
  return `<h2 class="eyebrow">${escapeHtml(heading)}</h2>
    <nav class="outline">${items
      .map(
        (item) =>
          `<a href="${escapeHtml(item.href)}"${item.current ? ' aria-current="true"' : ''}>${escapeHtml(
            item.label,
          )}</a>`,
      )
      .join('')}</nav>`
}

/**
 * A small card under the outline. The body is authored markup from this repository, so it travels
 * as it is — the same bargain the guide's prose makes.
 */
export function railCard(title: string, body: string): string {
  return `<div class="rail-card">
    <h2 class="eyebrow">${escapeHtml(title)}</h2>
    ${body}
  </div>`
}

/** The card the pages that really are files carry, because it is the claim worth making twice. */
export const IS_A_FILE = railCard(
  'This page is a file',
  `<p class="hint">It reads nothing, so <code>weft build</code> proved it byte-identical under two very
   different requests and wrote it to <code>.weft/static/</code>.</p>`,
)

/**
 * How far through a sequence you are, as a bar and as a fraction.
 *
 * A number on its own ("4 / 6") is a fact; the bar is the reason it is worth showing — somebody
 * four steps into a tutorial is deciding whether to finish it now, and two thirds of a line answers
 * that faster than a sentence.
 */
export function progress(at: number, total: number, takes = ''): string {
  const done = total ? Math.round((at / total) * 100) : 0
  return `<div class="rail-card">
    <div class="rail-card-head">
      <h2 class="eyebrow">Progress</h2>
      <span class="rail-card-num">${at} / ${total}</span>
    </div>
    <div class="bar" role="img" aria-label="${at} of ${total} steps read">
      <div class="bar-fill" style="width:${done}%"></div>
    </div>
    ${takes ? `<p class="rail-card-time">${escapeHtml(takes)}</p>` : ''}
  </div>`
}
