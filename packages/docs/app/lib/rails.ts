import { escapeHtml } from './escape.ts'

/**
 * The two things that go in an outline column, written once — six routes were each hand-building
 * both. Unlike the left contents rail (a sealed template, byte-identical across a section), these
 * differ per page, so a fragment would buy a template nothing reuses.
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

/** A small card under the outline. The body is authored markup, so it travels as-is — same bargain the guide's prose makes. */
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

/** How far through a sequence you are, as a bar and a fraction — a bar answers "should I finish now" faster than a sentence. */
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

/** The reader's own application at the end of the step they're on. Files this step added are marked, so it also answers "what did I just change". */
export function soFar(rows: readonly { depth: number; name: string; fresh: boolean }[]): string {
  if (!rows.length) return ''
  return `<div class="rail-card">
    <h2 class="eyebrow">Your app so far</h2>
    <div class="so-far">${rows
      .map(
        (row) =>
          `<div class="so-far-row${row.fresh ? ' fresh' : ''}" style="padding-inline-start:${
            row.depth * 12
          }px">${escapeHtml(row.name)}</div>`,
      )
      .join('')}</div>
  </div>`
}
