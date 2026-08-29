/** The showcases' form widgets. `data-weft-control` and `data-weft-apply` are the framework's own convention — the whole of wiring a control. */
function paramOf(id: string): string {
  const dash = id.indexOf('-')
  return dash < 0 ? id : id.slice(dash + 1)
}

export function panel(inner: string, hint?: string): string {
  return `<div class="card"><div class="controls">${inner}</div>${hint ? `<p class="hint">${hint}</p>` : ''}</div>`
}

export function field(label: string, control: string): string {
  return `<label>${label}${control}</label>`
}

export function slider(id: string, min: number, max: number, value: number, step = 1): string {
  return (
    `<input type="range" id="${id}" data-weft-control="${paramOf(id)}"` +
    ` min="${min}" max="${max}" step="${step}" value="${value}">`
  )
}

export function pick(id: string, options: readonly string[], selected?: string): string {
  const opts = options
    .map((o) => `<option value="${o}"${o === selected ? ' selected' : ''}>${o}</option>`)
    .join('')
  return `<select id="${id}" data-weft-control="${paramOf(id)}">${opts}</select>`
}

/** A button whose name ends in `-go`, `-run`, `-reload` or `-reschedule` applies the controls. */
export function press(id: string, label: string): string {
  const applies = /-(go|run|reschedule|reload)$/.test(id) ? ' data-weft-apply' : ''
  return `<button type="button" id="${id}"${applies}>${label}</button>`
}
