import type { Hint } from './infer.ts'

/**
 * The whole of this site's own browser code.
 *
 * The framework's runtime adopts the page; this is what the *documentation* adds on top, and the
 * rule it is written under is that nothing here may be load-bearing. The theme toggle enhances a
 * palette the stylesheet already picks. The finder enhances a `GET` form that already works. The
 * editor enhances a `<textarea>` inside a form that already compiles on submit. Turn scripting off
 * and every one of those still does its job — which is the claim the site makes about the
 * framework, so it had better be true of the site.
 *
 * It is loaded after adoption, which is why the theme is *not* here: a palette applied after paint
 * is a flash, so that one line runs inline in the head. See `BOOT` in `lib/shell.ts`.
 *
 * The highlighter and the type scan are `import()`ed rather than imported, and the budget is the
 * argument: they are 4 KB the playground needs and no other page does, and this site publishes what
 * a page downloads. A static import would have put them on all 375 of them.
 */

const root = document.documentElement

/* ── the theme toggle ─────────────────────────────────────────────────────── */

/**
 * Three states internally, two to the reader, and never a click that changes nothing.
 *
 * The obvious cycle — system, light, dark — has a hole in it: when the system says dark, the state
 * *after* explicit dark is "system", which also renders dark. The palette does not move, so the
 * toggle looks broken and the reader clicks again. Cycling by name is the mistake; what a reader is
 * choosing is an appearance.
 *
 * So the click is computed from the appearance in front of them: dark goes to light, light goes to
 * dark, always. `system` is not a third click — it is what *storing nothing* means, and the reader
 * arrives back at it whenever the value they picked is the one the system was already saying. Which
 * is the right default to drift back towards: a reader who matches their system has not opted out
 * of it, and should not have to.
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

    /**
     * The swap happens whether or not the animation does.
     *
     * `startViewTransition` takes a callback and runs it at the next rendering opportunity — so if
     * the transition is aborted before then (a hidden tab, a second one already running, a browser
     * that decides not to), the callback never runs and the theme never changes. An animation that
     * cannot play must not take the thing it was decorating with it, so `swap` is idempotent and
     * every path that can fail calls it.
     */
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

    // The corner of the page, not of the button. A circle centred a few pixels inside the viewport
    // shows a sliver of the old palette down the top and right edges for the whole sweep, which is
    // the one part of the frame a reader's eye is already on. From the corner itself the arc leaves
    // nothing behind it.
    const x = innerWidth
    const y = 0
    const reach = Math.hypot(innerWidth, innerHeight)

    /**
     * Strip the expensive decorations for the length of the sweep.
     *
     * `styles.css` has carried the `.theming` rules since the reveal was written, and nothing ever
     * added the class — so the backdrop-filter behind the header and the halo behind every card
     * were being re-rasterised on every frame of a whole-page snapshot the entire time, and the
     * figures kept animating under it. The hitch was at the *end*, where the snapshot is discarded
     * and the live page repaints all of it at once.
     *
     * Removed on `finished` rather than on `ready`, because the tear-down is the frame that was
     * dropping.
     */
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
      // The *radius* is what is animated, and area grows as its square — so an easing with a soft
      // tail spends its last third covering almost nothing, which reads as the animation stalling
      // just before it finishes. This curve is close to linear where it matters and eases only at
      // the very end, which keeps the edge moving at a steady apparent speed.
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${reach}px at ${x}px ${y}px)`] },
        { duration: 420, easing: 'cubic-bezier(.33,0,.2,1)', pseudoElement: '::view-transition-new(root)' },
      )
    }, swap)
  })
}

/* ── the light that follows the cursor ────────────────────────────────────── */

/**
 * One listener for every hoverable thing on the page.
 *
 * The selector list is the same one `styles.css` paints the wash for — the one duplication between
 * the two files, and both say so. A listener per element would be a hundred listeners on the API
 * page; a single delegated `pointermove` with a `closest()` is one, and it writes two custom
 * properties rather than touching layout, so the browser can keep it off the main thread's critical
 * path entirely.
 */
const GLOWS =
  '.glow, a.card, .btn, .chip, .stat, .absence, .verdict, .rail-card, .finder-hit, .top-icon,' +
  ' .jump a, .contents a, .outline a, .tty-tab span, .pane-tab span, .panel-tab-in'

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

/* ── ⌘K, over the form that already works ─────────────────────────────────── */

/**
 * The finder: the results page, arriving sooner.
 *
 * It fetches `/search?q=` and lifts `#finder-list` out of the answer. That is deliberate and it is
 * the whole reason there is no index in this bundle: the list it shows is the one the page shows,
 * rendered by the same builder from the same registries, so the panel cannot drift from the page
 * and a result cannot point at something that has been renamed. What a prebuilt index would buy is
 * one round trip; what it would cost is a second copy of the content, downloaded by every reader
 * whether they search or not.
 *
 * Submitting still navigates. Escape closes. With scripting off none of this exists and the form
 * goes to `/search`, which is the same answer one paint later.
 */
function finder(): void {
  const form = document.querySelector<HTMLFormElement>('form.find')
  const input = form?.querySelector<HTMLInputElement>('input[name=q]')
  if (!form || !input || form.dataset.wired === 'yes') return
  form.dataset.wired = 'yes'

  const panel = document.createElement('div')
  panel.className = 'finder'
  panel.hidden = true
  panel.setAttribute('role', 'listbox')
  const scrim = document.createElement('div')
  scrim.className = 'finder-scrim'
  scrim.hidden = true
  document.body.append(scrim, panel)

  let at = -1
  let token = 0

  const hits = () => [...panel.querySelectorAll<HTMLAnchorElement>('.finder-hit')]
  const mark = () => {
    hits().forEach((hit, i) => hit.toggleAttribute('aria-current', i === at))
    hits()[at]?.scrollIntoView({ block: 'nearest' })
  }
  /**
   * The box you typed into stays where you typed into it.
   *
   * The scrim sits above the header, so opening the panel put the search input *behind* it: the
   * query was still there and still focused, but dimmed, unclickable, and — if focus was ever lost
   * — unrecoverable without closing the panel first. A search you cannot keep typing into is a
   * search you have to start again.
   *
   * So the form is lifted over both the scrim and the panel for as long as the panel is open. The
   * class goes on the root rather than the form because the header is replaced wholesale by a
   * staged navigation, and an attribute on an element that may not survive is a latch that sticks.
   */
  const close = () => {
    panel.hidden = true
    scrim.hidden = true
    root.classList.remove('finding')
    at = -1
  }
  /**
   * The panel hangs under the box you typed into, rather than floating in the middle of the page.
   *
   * A centred palette is a fine pattern when the palette owns the query. This one does not — the
   * query stays in the header — so a panel in the middle of the screen puts the text you are typing
   * and the results of typing it in two different places, with a dimmed header between them.
   *
   * Measured rather than declared, because the header is centred in a shell whose width is a token
   * and whose gutters change at two breakpoints: the one thing that reliably knows where the search
   * box is, is the search box. Right-aligned to it, so a wide panel grows leftwards into the page
   * instead of off the edge of it.
   */
  const place = () => {
    const box = form.getBoundingClientRect()
    const width = Math.min(660, innerWidth - 24)
    panel.style.top = `${Math.round(box.bottom + 16)}px`
    panel.style.left = `${Math.round(Math.max(12, box.right - width))}px`
    panel.style.width = `${width}px`
  }

  const open = () => {
    place()
    panel.hidden = false
    scrim.hidden = false
    root.classList.add('finding')
  }

  addEventListener('resize', () => {
    if (!panel.hidden) place()
  })

  async function run(query: string): Promise<void> {
    const mine = ++token
    if (!query.trim()) return close()
    open()
    panel.innerHTML = '<div class="finder-wait">Searching…</div>'
    try {
      const response = await fetch(`/search?q=${encodeURIComponent(query)}`, {
        headers: { accept: 'text/html' },
      })
      if (mine !== token) return
      const doc = new DOMParser().parseFromString(await response.text(), 'text/html')
      const list = doc.querySelector('#finder-list')
      panel.innerHTML = list ? list.innerHTML : '<div class="finder-empty">Nothing matches.</div>'
      // No "see all" link. The panel already shows every match the page would, and a reader who is
      // in it is not looking for a second place to be.
      panel.insertAdjacentHTML(
        'beforeend',
        '<div class="finder-foot"><span><kbd>↵</kbd>open</span><span><kbd>↑</kbd><kbd>↓</kbd>navigate</span>' +
          '<span><kbd>esc</kbd>close</span></div>',
      )
      at = 0
      mark()
    } catch {
      if (mine === token) panel.innerHTML = '<div class="finder-empty">The search request failed.</div>'
    }
  }

  let timer = 0
  input.addEventListener('input', () => {
    clearTimeout(timer)
    timer = window.setTimeout(() => void run(input.value), 120)
  })
  input.addEventListener('focus', () => {
    if (input.value.trim()) void run(input.value)
  })
  scrim.addEventListener('click', close)

  input.addEventListener('keydown', (event) => {
    const list = hits()
    if (event.key === 'Escape') return close()
    if (!list.length) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      at = (at + 1) % list.length
      return mark()
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      at = (at - 1 + list.length) % list.length
      return mark()
    }
    if (event.key === 'Enter' && at >= 0) {
      event.preventDefault()
      list[at]?.click()
    }
  })

  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      input.focus()
      input.select()
    }
  })
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
 * A textarea over its own highlighted shadow.
 *
 * The oldest trick there is and still the right one: the `<textarea>` keeps its caret, its
 * selection, its undo stack and its accessibility, and a `<pre>` underneath — the same bytes, run
 * through the same highlighter the server used — supplies the colour. Nothing re-implements a text
 * editor, which is the failure mode this avoids rather than the feature it lacks.
 *
 * The hints beside it are `infer.ts` on every keystroke, debounced. The compile is still the
 * server's, on submit; this is what the reader gets in between.
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

  // Two rhythms, because the two halves cost different amounts. The colour is repainted on the
  // next frame — a highlighter over a few hundred bytes is cheaper than the keystroke that caused
  // it, and anything slower reads as the editor lagging behind the caret. The hint table walks the
  // whole module and rebuilds a table, so it waits until the typing stops.
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
 * A rail keeps where it was scrolled to.
 *
 * The contents rail is twenty-two page titles in a column shorter than they are, so a reader four
 * pages down has scrolled it — and every link in it navigates, which brings a new rail scrolled to
 * the top. The page they just left goes with it, and they have to find their place again on every
 * click, which makes the rail actively worse than a flat list.
 *
 * So the offset is remembered per rail and put back. `sessionStorage` rather than a variable
 * because a real document request replaces this module too; keyed by the rail's own label, which is
 * what distinguishes the contents column from the outline beside it. Storage can throw — a private
 * window, or site data switched off — and a rail that fails to remember its scroll offset is not
 * worth an exception, so both halves are wrapped and the fallback is the old behaviour.
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
 * Everything, and again after every client-side navigation.
 *
 * A staged navigation of kind `document` replaces the shell — which means the header's button and
 * the search form are new elements, and `data-js` is gone, because it was set by an inline script
 * that ran once at parse time and a swapped document does not re-run it. That is why the theme
 * toggle disappeared after the first click on a link: nothing was broken, the attribute the
 * stylesheet gates on had simply left with the old document.
 *
 * So the flag is re-asserted here and every step is idempotent — the two that bind to an element
 * mark it, the glow is delegated to `document` and binds once, and the editor is *meant* to run
 * again, because `/play` arrives with a textarea that did not exist a moment ago.
 *
 * The inline script still sets `data-js` before paint on a real document request. That is the case
 * this cannot cover, and the one where a control appearing late would be visible.
 */
function wire(): void {
  root.dataset.js = 'on'
  /**
   * And the palette, for the same reason.
   *
   * `data-theme` is an attribute on `<html>`, and a staged navigation of kind `document` brings a
   * new `<html>` from the server — which has never heard of a choice this reader made in the
   * browser two clicks ago. So the theme reverted on the first link they followed. The stored value
   * is the source of truth and this is the second place that reads it; the first is the inline
   * script, which covers the case this one cannot: before the first paint.
   */
  try {
    const stored = localStorage.getItem('weft-theme')
    if (stored === 'light' || stored === 'dark') root.dataset.theme = stored
    else delete root.dataset.theme
  } catch {}
  theme()
  glow()
  finder()
  rails()
  void editor()
}

wire()
document.addEventListener('weft:navigated', wire)
