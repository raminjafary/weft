import { escapeHtml } from './escape.ts'
import { highlight } from './highlight.ts'

/**
 * The figures, and the small motion language they share.
 *
 * The design's rule for this site is that a figure moves only where the movement *is* the idea —
 * an order of arrival, a size against another size, a value being swapped, a declaration being
 * refused. So the vocabulary is deliberately five things and not fifty: a sweep, a sequence, a bar
 * that grows, a swap, a refusal. A reader who has understood one figure has understood how the next
 * one speaks, which is worth more than each figure being individually clever.
 *
 * Every animated element carries `data-wf`. That is the whole of the reduced-motion contract: one
 * rule in `styles.css` switches the animations off and pins each element to its settled state, and
 * because every keyframe here *ends* at the state that makes the point, the still version is the
 * diagram rather than a blank box.
 *
 * These build markup rather than being fragments, because they appear inside authored prose. The
 * pieces that are the same on every page of a section — the contents rail — are fragments, for the
 * opposite reason: a sealed template is worth having exactly when it is reused byte for byte.
 */

const enc = escapeHtml

/** A caption bar, or nothing at all when a figure has no file to name. */
function cap(text: string, extra = ''): string {
  return text ? `<figcaption>${enc(text)}${extra}</figcaption>` : ''
}

/**
 * A terminal block with a tab per package manager.
 *
 * The tabs are radio inputs and the panels are chosen by `:has(:checked)`, so this is a real
 * control with no script behind it — the same trick the design system's segmented control uses, and
 * the reason the quick start still works with the runtime switched off.
 */
export function terminal(
  id: string,
  tabs: readonly { label: string; lines: readonly string[] }[],
  footer = '',
): string {
  const name = `tab-${id}`
  return `<figure class="tty" role="group" aria-label="Install commands">
    <div class="tty-tabs">${tabs
      .map(
        (tab, at) =>
          `<label class="tty-tab"><input type="radio" name="${enc(name)}" value="${enc(tab.label)}"${
            at === 0 ? ' checked' : ''
          }><span>${enc(tab.label)}</span></label>`,
      )
      .join('')}</div>
    ${tabs
      .map(
        (tab) =>
          `<pre class="tty-panel" data-tab="${enc(tab.label)}"><code>${tab.lines
            .map((line) => shellLine(line))
            .join('')}</code></pre>`,
      )
      .join('')}
    ${footer ? `<div class="tty-foot">${footer}</div>` : ''}
  </figure>`
}

/**
 * One terminal line. A leading `$` is a prompt and what follows it is a command; anything else is
 * output, which is dimmer — a reader scanning for what to type should find it without reading.
 */
function shellLine(line: string): string {
  if (!line.startsWith('$ ')) return `<span class="out">${enc(line) || '&#160;'}</span>`
  return `<span class="in"><span class="prompt">$</span> ${highlight('sh', line.slice(2))}</span>`
}

/**
 * A file tree beside the file that matters, which is the shape the route table wants explaining in.
 *
 * `lit` is the path the prose is about. Marking it is the whole reason this is a component and not
 * two figures side by side: the point of the pair is *which* file in the tree the code belongs to.
 */
export function tree(
  paths: readonly string[],
  lit: readonly string[],
  lang: string,
  code: string,
  caption = '',
): string {
  const rows = paths
    .map((path) => {
      const depth = path.split('/').length - 1 - (path.endsWith('/') ? 1 : 0)
      const name = path.replace(/\/$/, '').split('/').pop() ?? path
      const dir = path.endsWith('/')
      const on = lit.includes(path)
      return `<div class="tree-row${dir ? ' dir' : ''}${on ? ' lit' : ''}" style="padding-inline-start:${
        depth * 14
      }px">${enc(dir ? `${name}/` : name)}</div>`
    })
    .join('')
  return `<figure class="split">
    ${cap(caption)}
    <div class="split-in">
      <div class="tree">${rows}</div>
      <pre><code data-lang="${enc(lang)}">${highlight(lang, code.trim())}</code></pre>
    </div>
  </figure>`
}

/**
 * The two delivery orders, raced.
 *
 * Both tracks are the same width and the same duration; the only difference is when each region's
 * band appears, which is the entire claim. The playhead is one element per track rather than one
 * shared, so the tracks stay independent under `prefers-reduced-motion` — where the settled state
 * is both regions painted and no head at all.
 */
export function streamRace(
  slow = 'fast region visible at 103 ms',
  fast = 'fast region visible at 22 ms',
): string {
  return `<figure class="race">
    <div class="race-head"><span>in order</span><span class="race-num">${enc(slow)}</span></div>
    <div class="track">
      <div class="track-bed"></div>
      <div data-wf class="race-band late" style="animation:wf-fast-io 3.2s linear infinite"></div>
      <div data-wf class="race-play" style="animation:wf-play 3.2s linear infinite"></div>
    </div>
    <div class="race-head second"><span>out of order</span><span class="race-num lit">${enc(fast)}</span></div>
    <div class="track">
      <div data-wf class="race-band early" style="animation:wf-fast-oo 3.2s linear infinite"></div>
      <div data-wf class="race-band rest" style="animation:wf-slow 3.2s linear infinite"></div>
      <div data-wf class="race-play lit" style="animation:wf-play 3.2s linear infinite"></div>
    </div>
  </figure>`
}

export interface WireRow {
  form: string
  what: string
  size: string
  /** 0–1. The bar's share of the widest row, so the picture is the ratio and not a decoration. */
  share: number
  lit?: boolean
}

/**
 * Three ways one region reaches the browser, drawn to scale.
 *
 * The bars grow from the left on a stagger, which is the one place a delay carries meaning here:
 * they arrive in the order the kernel would consider them, cheapest last.
 *
 * The stagger is nearly half a second, which is long for a figure this small and is the point: the
 * three bars are 17× apart in length, and a stagger short enough to read as one gesture would draw
 * them as one gesture. Held for most of a 4.4s cycle, so a reader who arrives mid-hold still finds
 * the comparison rather than an animation.
 */
export function wireBars(rows: readonly WireRow[], caption = ''): string {
  return `<figure class="wire">
    <div class="wire-rows">${rows
      .map(
        (row, at) => `<div class="wire-row">
          <div class="wire-head">
            <span class="wire-form">${enc(row.form)}</span>
            <span class="wire-what">${enc(row.what)}</span>
            <span class="wire-size${row.lit ? ' lit' : ''}">${enc(row.size)}</span>
          </div>
          <div data-wf class="wire-bar${row.lit ? ' lit' : ''}" style="width:${(row.share * 100).toFixed(
            1,
          )}%;animation:wf-grow 4.4s cubic-bezier(.2,.7,.3,1) ${(at * 0.45).toFixed(2)}s infinite"></div>
        </div>`,
      )
      .join('')}</div>
    ${caption ? `<figcaption class="wire-cap">${caption}</figcaption>` : ''}
  </figure>`
}

/**
 * A sequence of stages that light up in order — the shape every "and then" in this framework has.
 *
 * The stagger is computed from the count rather than written per stage, so inserting a stage does
 * not mean retiming the four after it.
 */
export function sequence(stages: readonly { label: string; note?: string }[], caption = ''): string {
  const step = 5.6 / Math.max(stages.length, 1)
  return `<figure class="seq">
    <div class="seq-rail">${stages
      .map(
        (stage, at) =>
          `<div data-wf class="seq-step" style="animation:wf-step 5.6s ease-out ${(at * step).toFixed(
            2,
          )}s infinite">
            <span class="seq-dot"></span>
            <span class="seq-label">${enc(stage.label)}</span>
            <span class="seq-note">${enc(stage.note ?? '')}</span>
          </div>`,
      )
      .join('')}</div>
    ${caption ? `<figcaption>${caption}</figcaption>` : ''}
  </figure>`
}

/** Stat tiles: a number, and what was measured to get it. */
export function stats(items: readonly { value: string; note: string; lit?: boolean }[]): string {
  return `<div class="stats">${items
    .map(
      (item) =>
        `<div class="stat${item.lit ? ' lit' : ''}"><b>${enc(item.value)}</b><span>${enc(
          item.note,
        )}</span></div>`,
    )
    .join('')}</div>`
}

/**
 * A diff, as the two lines that changed rather than as a file.
 *
 * A tutorial step that shows a whole file again to change two lines of it makes the reader do the
 * diffing, which is the job this figure exists to do for them.
 */
export function diff(lines: readonly string[], caption = '', badge = ''): string {
  const changed = lines.filter((line) => /^[-+]/.test(line)).length
  return `<figure class="code diff">
    ${cap(caption, badge ? `<span class="fig-badge">${enc(badge)}</span>` : `<span class="fig-badge">${changed} line${changed === 1 ? '' : 's'} changed</span>`)}
    <pre><code>${lines
      .map((line) => {
        const mark = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'same'
        return `<span class="dl ${mark}">${enc(line) || '&#160;'}</span>`
      })
      .join('')}</code></pre>
  </figure>`
}

/**
 * A pair of panels: what a valid declaration does, and what the framework refuses.
 *
 * The design keeps these two states in their own boxes rather than mixing them into one animated
 * figure, and it is right to: a refusal is not a frame of an animation, it is the other outcome.
 */
export function verdicts(ok: { title: string; body: string }, no: { title: string; body: string }): string {
  return `<div class="verdicts">
    <div class="verdict ok">
      <div class="verdict-head"><span class="verdict-mark">✓</span><span class="verdict-kind">Accepted</span></div>
      <h4>${enc(ok.title)}</h4>
      <p>${ok.body}</p>
    </div>
    <div class="verdict no">
      <div class="verdict-head"><span class="verdict-mark">✕</span><span class="verdict-kind">Refused</span></div>
      <h4>${enc(no.title)}</h4>
      <p>${no.body}</p>
    </div>
  </div>`
}

export interface BarRow {
  label: string
  /** What was configured to get this number. Some rows have nothing to add, and say nothing. */
  note?: string
  /** The number as it should read — already rounded, because rounding is a presentation decision. */
  value: string
  unit: string
  /** 0–1, the row's share of the longest bar in its own chart. */
  share: number
  /** The row this framework is, which is the one row that takes the accent. */
  lit?: boolean
}

/**
 * A measurement chart: one row per candidate, bar length carrying the number.
 *
 * The bars grow on a 0.16s stagger and the values fade in behind them, so a reader watches the
 * comparison assemble rather than arriving at a finished picture — and `wf-val` holds the number
 * for most of the cycle, because the number is what a reader came for and a figure that flashes it
 * is a figure that has to be waited for twice.
 *
 * Bar length is share-of-longest within one chart and never across charts: three of these sit on
 * the landing page measuring milliseconds, bytes and milliseconds again, and a bar that meant the
 * same width in all three would be comparing a byte to a millisecond.
 */
export function barChart(rows: readonly BarRow[], scale = ''): string {
  return `<div class="chart">${rows
    .map(
      (row, at) => `<div class="chart-row${row.lit ? ' lit' : ''}">
        <div class="chart-say">
          <div class="chart-label">${enc(row.label)}</div>
          ${row.note ? `<div class="chart-note">${enc(row.note)}</div>` : ''}
        </div>
        <div class="chart-track">
          <div data-wf class="chart-bar" style="width:${(row.share * 100).toFixed(
            1,
          )}%;animation:wf-bar 6.4s cubic-bezier(.2,.75,.3,1) ${(at * 0.16).toFixed(2)}s infinite"></div>
        </div>
        <div data-wf class="chart-val" style="animation:wf-val 6.4s linear ${(at * 0.16).toFixed(
          2,
        )}s infinite">${enc(row.value)}<span class="chart-unit"> ${enc(row.unit)}</span></div>
      </div>`,
    )
    .join('')}${scale ? `<p class="chart-scale">${enc(scale)}</p>` : ''}</div>`
}

/** A chart with its own heading, for the ones that sit in the page rather than in the band. */
export function chartBlock(title: string, note: string, rows: readonly BarRow[]): string {
  return `<section class="chart-block">
    <div class="chart-head">
      <span class="chart-title">${enc(title)}</span>
      <span class="chart-sub">${enc(note)}</span>
      <span class="chart-dir">lower is better</span>
    </div>
    ${barChart(rows)}
  </section>`
}
