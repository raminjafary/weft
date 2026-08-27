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
 * Three states, not two: light, dark, and *what the system says*.
 *
 * A two-state toggle silently opts a reader out of their own setting the first time they touch it,
 * which is a worse default than the one it replaced. The cycle returns to `system`, and `system` is
 * the absence of the attribute rather than a third value the stylesheet has to know about.
 *
 * The swap is a circular reveal out of the button, drawn by the View Transitions API: the new
 * palette is painted into a clip-path circle that grows to cover the viewport. That is the whole
 * trick — the browser snapshots both states and animates between them, so there is no second copy
 * of the page and nothing to keep in sync. Where the API is missing the palette simply changes,
 * which is what it did before.
 */
function theme(): void {
  const button = document.querySelector<HTMLButtonElement>('[data-theme-toggle]')
  if (!button) return
  const order = ['system', 'light', 'dark'] as const
  const next = () => order[(order.indexOf((root.dataset.theme ?? 'system') as never) + 1) % 3] as string
  const say = () =>
    button.setAttribute('aria-label', `Theme: ${root.dataset.theme ?? 'system'}. Switch to ${next()}`)
  say()

  const apply = (mode: string) => {
    if (mode === 'system') {
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
          updateCallbackDone?: Promise<void>
        }
      }
    ).startViewTransition
    if (!start || matchMedia('(prefers-reduced-motion: reduce)').matches) return swap()

    // The circle grows out of the toggle's own corner — the top right of the page, where the
    // reader just clicked — rather than out of its centre, so the first frame is a quarter arc
    // hugging the corner instead of a disc that appears to start slightly inside the page.
    const box = button.getBoundingClientRect()
    const x = box.right
    const y = box.top
    const reach = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))

    let transition
    try {
      transition = start.call(document, swap)
    } catch {
      return swap()
    }
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

function glow(): void {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
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
  if (!form || !input) return

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
  const close = () => {
    panel.hidden = true
    scrim.hidden = true
    at = -1
  }
  const open = () => {
    panel.hidden = false
    scrim.hidden = false
  }

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
      panel.insertAdjacentHTML(
        'beforeend',
        `<div class="finder-foot"><span><kbd>↵</kbd>open</span><span><kbd>↑</kbd><kbd>↓</kbd>navigate</span>
         <span><kbd>esc</kbd>close</span><a href="/search?q=${encodeURIComponent(query)}">See all on /search →</a></div>`,
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

theme()
glow()
finder()
void editor()
