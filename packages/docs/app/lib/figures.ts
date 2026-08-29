import { escapeHtml } from './escape.ts'
import { highlight } from './highlight.ts'
import { raceFigure } from './measured.ts'

/**
 * The figures, and the small motion language they share: five kinds — sweep, sequence, growing bar,
 * swap, refusal — each moving only where movement *is* the idea. Every animated element carries
 * `data-wf`, the whole reduced-motion contract: one CSS rule pins each to its settled (meaningful)
 * end state. These build markup rather than being fragments because they sit inside authored prose.
 */

const enc = escapeHtml

/** A caption bar, or nothing at all when a figure has no file to name. */
function cap(text: string, extra = ''): string {
  return text ? `<figcaption>${enc(text)}${extra}</figcaption>` : ''
}

/** A terminal block with a tab per package manager — radio inputs and `:has(:checked)`, no script needed. */
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

/** A file tree beside the file that matters. `lit` marks which path the prose is about — the whole point of the pairing. */
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

/** The two delivery orders, raced — same width and duration, only the arrival timing differs. One playhead per track, so they stay independent under reduced motion. */
export function streamRace(
  slow = `fast region visible at ${raceFigure('chromium', 'in-order')}`,
  fast = `fast region visible at ${raceFigure('chromium', 'out-of-order')}`,
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
 * Three ways one region reaches the browser, drawn to scale. Bars grow on a stagger in the order
 * the kernel would consider them (cheapest last) — deliberately long (~0.5s) since the three bars
 * are 17× apart in length and a short stagger would read as one gesture instead of three.
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

/** A sequence of stages that light up in order. Stagger is computed from the count, so inserting a stage never means retiming the rest. */
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

/** The same numbers as `stats`, in one line with its qualifying sentence beside it — a header, not a set of comparison tiles. */
export function strip(items: readonly { value: string; note: string; lit?: boolean }[], aside = ''): string {
  return `<div class="strip">${items
    .map(
      (item) =>
        `<div class="strip-cell"><b${item.lit ? ' class="lit"' : ''}>${enc(item.value)}</b><span>${enc(
          item.note,
        )}</span></div>`,
    )
    .join('')}${aside ? `<p class="strip-note">${aside}</p>` : ''}</div>`
}

/** A diff, as the two lines that changed rather than the whole file — the reader shouldn't have to diff it themselves. */
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
 * A measurement chart: one row per candidate, bar length carrying the number. Bars grow on a
 * stagger and hold their value for most of the 3.4s cycle (shortened from 6.4s so three stacked on
 * the landing page don't make a scrolling reader wait out a hold). Share-of-longest is scoped per
 * chart, never across charts — three charts can measure ms, bytes, and ms again.
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
          )}%;animation:wf-bar 3.4s cubic-bezier(.35,.12,.3,1) ${(at * 0.14).toFixed(2)}s infinite"></div>
        </div>
        <div data-wf class="chart-val" style="animation:wf-val 3.4s linear ${(at * 0.14).toFixed(
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

export interface Verdict {
  title: string
  body: string
}

export interface Refusal extends Verdict {
  /** What you wrote, why it cannot stand, and what comes back. Three, always. */
  chips: readonly string[]
}

/**
 * What the page's mechanism accepts, and what it refuses — side by side, at the top, since a reader
 * deciding whether the framework will fight them wants the constraint first. The refusal's three
 * chips (what you wrote, the rule, what came back) light in compiler order. The tick pulses; the
 * cross doesn't — a refusal is a settled fact.
 */
export function verdictPair(ok: Verdict, no: Refusal): string {
  return `<div class="verdicts">
    <div class="verdict ok">
      <div class="verdict-head">
        <span data-wf class="verdict-mark" style="animation:wf-pulse 2.6s ease-in-out infinite">&#10003;</span>
        <span class="verdict-kind">Valid</span>
        <span class="verdict-what">${enc(ok.title)}</span>
      </div>
      <p>${enc(ok.body)}</p>
    </div>
    <div class="verdict no">
      <div class="verdict-head">
        <span class="verdict-mark">&#10005;</span>
        <span class="verdict-kind">Refused</span>
        <span class="verdict-what">${enc(no.title)}</span>
      </div>
      <div class="trace">${no.chips
        .map(
          (chip, at) =>
            `${at ? '<span class="trace-to">&#8594;</span>' : ''}<span data-wf class="trace-step${
              at === no.chips.length - 1 ? ' end' : ''
            }" style="animation:wf-step 4.8s linear ${(at * 0.5).toFixed(1)}s infinite">${enc(chip)}</span>`,
        )
        .join('')}</div>
      <p>${enc(no.body)}</p>
    </div>
  </div>`
}

/** The page in four sentences, before the page — the plain version, above the precise-and-dense prose it precedes. */
export function plainTerms(text: string): string {
  return `<div class="plain">
    <p class="plain-kicker">In plain terms</p>
    <p>${enc(text)}</p>
  </div>`
}
