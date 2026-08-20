import { applyDelta, project } from './project.js'

/**
 * Each form is measured as the whole job it actually is: bytes on the wire turned into
 * DOM in the document. The parse is included for every form, because every form has to
 * end with the region on screen.
 */
export function run({ template, html, data, delta, base, iterations, warmup, batch }) {
  const target = document.getElementById('target')
  const results = {}

  // Only forms the server actually offered are measured. A form that is not offered is
  // absent from the results rather than present with a zero.
  const forms = { html: () => { target.innerHTML = html } }
  if (data) {
    forms.data = () => {
      const payload = JSON.parse(data)
      target.innerHTML = project(template, payload.values)
    }
  }
  if (delta) {
    forms.delta = () => {
      const payload = JSON.parse(delta)
      target.innerHTML = project(template, applyDelta(base, payload.changed))
    }
  }

  // performance.now() is clamped to 100 microseconds in some engines and one payload
  // costs less than that, so each sample is the mean of a batch.
  for (const [form, fn] of Object.entries(forms)) {
    for (let i = 0; i < warmup * batch; i++) fn()
    const samples = []
    for (let i = 0; i < iterations; i++) {
      const start = performance.now()
      for (let k = 0; k < batch; k++) fn()
      samples.push((performance.now() - start) / batch)
    }
    results[form] = samples
  }

  results.nodes = target.querySelectorAll('*').length
  return results
}
