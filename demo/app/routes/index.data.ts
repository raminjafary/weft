import { defineRoute } from '@weft/core'
import { SHOWCASES } from '../lib/showcases.ts'

/**
 * The demo's index: the six shapes of page, and what makes each one hard.
 *
 * It used to list thirty-four stations, which is why this file used to import a station registry.
 * The stations moved to `@weft/inspector`, where taking the framework apart is the job — and this
 * page went back to being what a demo's index should be: the applications, and a link to the
 * inspector for anyone who wants the mechanisms underneath.
 */
export default defineRoute({
  head: { title: 'weft — six applications', description: 'Six shapes of page, built with weft.' },
  layoutValues: {
    heading: 'Six shapes of page',
    shows:
      'A framework can win every isolated benchmark and still be miserable to build a page with. These six are whole pages.',
    control: 'Open any of them. Each says what makes it hard and which capabilities carry it.',
    status: 'live',
  },
  cache: { class: 'public', ttl: '1h' },
  slots: {
    panel: { fragment: 'markup', stream: false, html: '' },
    body: {
      fragment: 'markup',
      stream: false,
      html: () =>
        SHOWCASES.map(
          (showcase) => `<div class="card">
            <h3><a href="${showcase.href}">${showcase.title}</a></h3>
            <p>${showcase.standsFor}</p>
            <ul class="leans">${showcase.leansOn.map((line) => `<li>${line}</li>`).join('')}</ul>
          </div>`,
        ).join(''),
    },
    readout: {
      fragment: 'markup',
      stream: false,
      html: `<div class="card"><h3>The mechanisms underneath</h3>
        <p>Every capability this framework has, with a control that lets you feel it, lives in the
        inspector — a station per mechanism, and a test that fails the build when a spec document
        has no station pointing at it.</p>
        <p class="hint"><code>pnpm inspect</code></p></div>`,
    },
  },
})
