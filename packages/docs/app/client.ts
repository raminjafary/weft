import type { Hint } from './infer.ts'

/**
 * The whole of this site's own browser code. Nothing here may be load-bearing: turn scripting off
 * and the theme toggle, finder, and editor all degrade to the plain control underneath. The theme
 * itself is not here — it runs inline in the head (see `BOOT` in `lib/shell.ts`) since applying it
 * after paint would flash. The highlighter and type scan are `import()`ed: 4 KB the playground
 * needs and no other page does, out of 375 pages.
 */

const root = document.documentElement

/* ── the theme toggle ─────────────────────────────────────────────────────── */

/**
 * Three states internally, two to the reader, never a click that changes nothing. Cycling by name
 * (system → light → dark → system) has a hole: after explicit dark when the system is already dark,
 * "system" renders the same as what's showing, so the click looks broken. Instead the click always
 * flips the visible appearance; "system" is just what storing nothing means, and a reader who
 * matches their system drifts back to it naturally.
 */
function theme(): void {
  const button = document.querySelector<HTMLButtonElement>('[data-theme-toggle]')
  // A navigation that replaced the shell brought a new button; one that replaced only regions left
  // this one alone. Marking it is what makes running this after every navigation safe.
  if (!button || button.dataset.wired === 'yes') return
  button.dataset.wired = 'yes'
  const dark = matchMedia('(prefers-color-scheme: dark)')
  const system = () => (dark.matches ? 'dark' : 'light')
  const showing = () => root.dataset.theme ?? system()
  const next = () => (showing() === 'dark' ? 'light' : 'dark')

  const say = () => {
    const follows = root.dataset.theme === undefined
    button.setAttribute(
      'aria-label',
      `Theme: ${showing()}${follows ? ', following your system' : ''}. Switch to ${next()}`,
    )
    button.setAttribute('aria-pressed', showing() === 'dark' ? 'true' : 'false')
  }
  say()

  const apply = (mode: string) => {
    if (mode === system()) {
      // The reader picked what their system already says, so stop overriding it: they are back to
      // following it, and a stored value that happens to agree today would stop agreeing tonight.
      delete root.dataset.theme
      try {
        localStorage.removeItem('weft-theme')
      } catch {}
    } else {
      root.dataset.theme = mode
      try {
        localStorage.setItem('weft-theme', mode)
      } catch {}
    }
    say()
  }

  // A reader who changes their system setting while following it should see the label follow too.
  dark.addEventListener('change', say)

  button.addEventListener('click', () => {
    const mode = next()

    // `swap` is idempotent and every failure path calls it: if the view transition aborts (hidden tab, one already running), its callback never runs, and the theme must still change.
    let swapped = false
    const swap = () => {
      if (swapped) return
      swapped = true
      apply(mode)
    }

    const start = (
      document as Document & {
        startViewTransition?: (cb: () => void) => {
          ready: Promise<void>
          finished: Promise<void>
          updateCallbackDone?: Promise<void>
        }
      }
    ).startViewTransition
    if (!start || matchMedia('(prefers-reduced-motion: reduce)').matches) return swap()

    // The corner of the page, not the button: centred a few pixels in, the arc leaves a sliver of the old palette along two edges for the whole sweep.
    const x = innerWidth
    const y = 0
    const reach = Math.hypot(innerWidth, innerHeight)

    // Strips the expensive decorations for the sweep: backdrop-filter and card halos were being
    // re-rasterised every frame of the snapshot because `.theming` in styles.css was never applied.
    // Removed on `finished`, not `ready` — the tear-down was the frame that was dropping.
    root.classList.add('theming')
    const settle = () => root.classList.remove('theming')

    let transition
    try {
      transition = start.call(document, swap)
    } catch {
      settle()
      return swap()
    }
    transition.finished.then(settle, settle)
    transition.updateCallbackDone?.catch(swap)
    transition.ready.then(() => {
      // Radius is animated but area grows as its square, so a soft-tailed easing reads as stalling near the end; this curve stays near-linear until the very end.
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${reach}px at ${x}px ${y}px)`] },
        { duration: 420, easing: 'cubic-bezier(.33,0,.2,1)', pseudoElement: '::view-transition-new(root)' },
      )
    }, swap)
  })
}

/* ── the light that follows the cursor ────────────────────────────────────── */

/** One delegated `pointermove` listener for every hoverable thing, rather than one per element (a hundred on the API page). Selector list mirrors styles.css. */
const GLOWS =
  '.glow, a.card, .btn, .chip, .stat, .absence, .verdict, .rail-card, .finder-hit, .top-icon,' +
  ' .contents a, .outline a, .tty-tab span, .pane-tab span, .panel-tab-in'

let glowing = false

function glow(): void {
  if (glowing || matchMedia('(prefers-reduced-motion: reduce)').matches) return
  glowing = true
  document.addEventListener(
    'pointermove',
    (event) => {
      const target = (event.target as Element | null)?.closest?.(GLOWS)
      if (!(target instanceof HTMLElement)) return
      const box = target.getBoundingClientRect()
      target.style.setProperty('--mx', `${event.clientX - box.left}px`)
      target.style.setProperty('--my', `${event.clientY - box.top}px`)
    },
    { passive: true },
  )
}

/* ── the playground's editor ──────────────────────────────────────────────── */

const KIND: Record<Hint['where'], string> = { text: 'text', attr: 'attr', list: 'list' }

type Inferred = { hints: Hint[]; reads: { taint: string }[]; cacheClass: string; notes: string[] }

function hintRows(inferred: Inferred): string {
  const { hints, reads, cacheClass, notes } = inferred
  const rows = hints.length
    ? hints
        .map(
          (hint) => `<tr${hint.undeclared ? ' class="unknown"' : ''}>
            <td><code>${hint.binding}</code></td>
            <td><code>${hint.type}</code></td>
            <td><code>${KIND[hint.where]}</code></td>
            <td><code>${hint.escape}</code></td>
            <td class="hint">${hint.line}</td>
          </tr>`,
        )
        .join('')
    : '<tr><td colspan="5" class="hint">No holes yet — every byte of this template would be constant.</td></tr>'
  const taints = reads.length
    ? reads.map((read) => `<code>${read.taint}</code>`).join(' ')
    : '<em>nothing</em>'
  return `<div class="scroll"><table>
      <thead><tr><th>Binding</th><th>Type</th><th>Hole</th><th>Escape</th><th>Line</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <dl class="prov"><div class="prov-row"><dt>Reads</dt><dd>${taints}</dd></div>
      <div class="prov-row"><dt>Cache class</dt><dd><code>${cacheClass}</code></dd></div></dl>
    ${notes.map((note) => `<p class="hint">${note}</p>`).join('')}`
}

/**
 * A `<textarea>` over its own highlighted shadow `<pre>` — keeps native caret/selection/undo/a11y,
 * the shadow only supplies colour. Nothing re-implements a text editor. The hints beside it are
 * `infer.ts` on every keystroke, debounced; the compile is still the server's, on submit.
 */
async function editor(): Promise<void> {
  const box = document.querySelector<HTMLElement>('.editor')
  const area = box?.querySelector<HTMLTextAreaElement>('textarea')
  const shadow = box?.querySelector<HTMLElement>('.editor-hl code')
  const hints = document.querySelector<HTMLElement>('#hints')
  if (!box || !area || !shadow) return

  // Fetched only now, on the one page that has an editor. Until they land the textarea is an
  // ordinary textarea over a server-highlighted shadow, which is what it is with scripting off.
  const [{ highlight }, { infer }] = await Promise.all([import('./hl.ts'), import('./infer.ts')])
  box.classList.add('live')

  const paint = () => {
    // A trailing newline collapses in a `<pre>`, so the shadow ends one line short of the caret.
    shadow.innerHTML = highlight('tsx', `${area.value}\n`)
    if (hints) hints.innerHTML = hintRows(infer(area.value))
  }
  const sync = () => {
    const pre = shadow.parentElement as HTMLElement
    pre.scrollTop = area.scrollTop
    pre.scrollLeft = area.scrollLeft
  }

  // Two rhythms: colour repaints next frame (cheap, must track the caret); hints wait until typing stops (rebuilds the whole table).
  let frame = 0
  let timer = 0
  area.addEventListener('input', () => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      shadow.innerHTML = highlight('tsx', `${area.value}\n`)
      sync()
    })
    clearTimeout(timer)
    timer = window.setTimeout(() => {
      if (hints) hints.innerHTML = hintRows(infer(area.value))
    }, 160)
  })
  area.addEventListener('scroll', sync)

  // ⌘↵ submits, which is what the button beside it says it does.
  area.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') area.form?.requestSubmit()
    if (event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault()
      const { selectionStart: from, selectionEnd: to } = area
      area.setRangeText('  ', from, to, 'end')
      paint()
    }
  })

  paint()
}

/**
 * A rail keeps where it was scrolled to — without this, every link click resets the contents rail
 * to the top and the reader has to re-find their place, worse than a flat list. `sessionStorage`
 * survives a real document request replacing this module; storage can throw (private window), so
 * both read and write are wrapped and the fallback is just not remembering.
 */
function rails(): void {
  for (const rail of document.querySelectorAll<HTMLElement>('.rail, .outline-rail')) {
    if (rail.dataset.kept === 'yes') continue
    rail.dataset.kept = 'yes'
    const key = `weft-rail:${rail.getAttribute('aria-label') ?? ''}`
    try {
      const at = Number(sessionStorage.getItem(key))
      if (at > 0) rail.scrollTop = at
    } catch {}
    rail.addEventListener(
      'scroll',
      () => {
        try {
          sessionStorage.setItem(key, String(rail.scrollTop))
        } catch {}
      },
      { passive: true },
    )
  }
}

/**
 * Everything, and again after every client-side navigation. A `document`-kind staged navigation
 * replaces the shell, so `data-js` (set by an inline script that only runs once at parse time) and
 * the header/search elements are new — hence re-asserting the flag and re-running every step here,
 * idempotently. The inline script still covers first paint on a real document request.
 */
function wire(): void {
  root.dataset.js = 'on'
  // Same reason: a fresh `<html>` from the server has never heard the reader's stored theme choice. This is the second place that reads it; the inline script covers before-first-paint.
  try {
    const stored = localStorage.getItem('weft-theme')
    if (stored === 'light' || stored === 'dark') root.dataset.theme = stored
    else delete root.dataset.theme
  } catch {}
  theme()
  glow()
  rails()
  void editor()
}

wire()
document.addEventListener('weft:navigated', wire)
