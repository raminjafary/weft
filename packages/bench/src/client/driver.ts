import { adopt, type Adopted } from '/runtime/adopt.ts'
import { applyDelta, type DeltaPayload } from '/runtime/delta.ts'
import { signal } from '/runtime/signal.ts'
import type { ClientTemplate, Json } from '/runtime/template.ts'

interface Config {
  template: ClientTemplate
  resident: Record<string, ClientTemplate>
  /** The server's render of the values the page was sent. */
  html: string
  /** The server's render of the values the delta moves to — the DOM adoption must reach. */
  expected: string
  delta: DeltaPayload
  iterations: number
  batch: number
}

/**
 * Batches are sized so that a batch's elapsed time clears the coarsest clock in the
 * engine set: WebKit reports performance.now() in far bigger steps than Chromium, and a
 * batch that lands inside one step reads as zero.
 */

/**
 * DOM equality, not string equality. A marker comment written as `<!>` is serialised back
 * as `<!---->`, so comparing innerHTML compares serialisation syntax; the claim is about
 * the tree the browser ends up with.
 */
function sameDom(html: string, host: HTMLElement): boolean {
  const reference = document.createElement('div')
  reference.innerHTML = html
  return reference.isEqualNode(host)
}

interface Check {
  name: string
  ok: boolean
  detail?: string
}

const config = JSON.parse(document.getElementById('config')!.textContent!) as Config

function region(html: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = html
  document.body.appendChild(host)
  return host
}

function adoptRegion(host: HTMLElement): Adopted {
  return adopt({ root: host, template: config.template, resident: config.resident })
}

function checks(): Check[] {
  const out: Check[] = []

  const host = region(config.html)
  const adopted = adoptRegion(host)
  const untouched = sameDom(config.html, host)
  out.push({
    name: 'adoption does not disturb the server render',
    ok: untouched,
    ...(untouched ? {} : { detail: host.innerHTML.slice(0, 160) }),
  })

  const writes = applyDelta(adopted, config.delta)
  const ok = sameDom(config.expected, host)
  out.push({
    name: 'a delta applied surgically reaches the same DOM as a fresh render',
    ok,
    detail: ok ? `${writes} writes` : firstDifference(config.expected, host.innerHTML),
  })

  out.push({
    name: 'a delta writes one value per changed path, not a region',
    ok: writes === Object.keys(config.delta.changed).length,
    detail: `${writes} writes for ${Object.keys(config.delta.changed).length} paths`,
  })

  // An empty value leaves no text node, so the marker has to be the anchor.
  const emptied = region(config.html)
  const secondAdopted = adoptRegion(emptied)
  const anchored = config.template.holes.find((h) => h.anchor !== undefined)
  if (anchored) {
    const before = emptied.innerHTML
    secondAdopted.write(anchored.binding, '')
    const cleared = emptied.innerHTML
    secondAdopted.write(anchored.binding, 'restored')
    out.push({
      name: 'an anchored value survives being emptied and rewritten',
      ok: cleared !== before && emptied.innerHTML.includes('restored'),
      detail: emptied.innerHTML.slice(0, 120),
    })
  }

  const wired = region(config.html)
  const bound = adopt({ root: wired, template: config.template, resident: config.resident })
  const textHole = config.template.holes.find((h) => h.kind === 'text')
  if (textHole && bound.target(textHole.binding)) {
    bound.write(textHole.binding, 12345 as Json)
    out.push({
      name: 'a bound value writes through to its own node',
      ok: wired.innerHTML.includes('12345'),
      ...(wired.innerHTML.includes('12345') ? {} : { detail: wired.innerHTML.slice(0, 120) }),
    })
  }

  // A signal write has to reach the DOM through the wiring table, not through a direct
  // call. Without this check a template with no wiring measures an empty loop.
  const bindings = wiredBindings()
  if (bindings.length) {
    const host = region(config.html)
    const signals = Object.fromEntries(bindings.map((binding) => [binding, signal(0 as never)]))
    adopt({ root: host, template: config.template, resident: config.resident, signals })
    const binding = bindings[0] as string
    const before = host.innerHTML
    signals[binding]!.set(4242 as never)
    out.push({
      name: 'a signal write reaches the DOM through the wiring table',
      ok: host.innerHTML !== before && host.innerHTML.includes('4242'),
      ...(host.innerHTML.includes('4242') ? {} : { detail: host.innerHTML.slice(0, 160) }),
    })
  }

  for (const host of [...document.body.children]) host.remove()
  return out
}

/** Bindings a signal can actually drive: the value ops in the wiring table. */
function wiredBindings(): string[] {
  return [...new Set(config.template.wiring.filter((w) => w.op !== 'event').map((w) => w.binding))]
}

function measure(batch: number, prepare: () => () => void): number[] {
  const samples: number[] = []
  for (let i = 0; i < config.iterations; i++) {
    const run = prepare()
    for (let k = 0; k < 5; k++) run()
    const start = performance.now()
    for (let k = 0; k < batch; k++) run()
    samples.push((performance.now() - start) / batch)
  }
  return samples
}

function timings(): Record<string, number[]> {
  // A surgical delta is a handful of writes, far below what the clock can resolve, so it
  // gets a much larger batch than adoption does.
  const samples = {
    adopt: measure(config.batch * 5, () => {
      const host = region(config.html)
      return () => void adoptRegion(host)
    }),
    delta: measure(config.batch * 500, () => {
      const host = region(config.html)
      const adopted = adoptRegion(host)
      return () => void applyDelta(adopted, config.delta)
    }),
    parse: measure(config.batch * 5, () => {
      const host = region('')
      return () => {
        host.innerHTML = config.expected
      }
    }),
    // One signal write reaching the nodes the wiring table binds it to: the axis this
    // design expects to tie. Absent when the template wires nothing, rather than zero.
    ...(wiredBindings().length
      ? {
          write: measure(config.batch * 5000, () => {
            const host = region(config.html)
            const binding = wiredBindings()[0] as string
            const value = signal(0)
            adopt({
              root: host,
              template: config.template,
              resident: config.resident,
              signals: { [binding]: value as never },
            })
            let n = 0
            return () => value.set(++n)
          }),
        }
      : {}),
  }
  for (const host of [...document.body.children]) host.remove()
  return samples
}

function firstDifference(expected: string, actual: string): string {
  const length = Math.min(expected.length, actual.length)
  for (let i = 0; i < length; i++) {
    if (expected[i] !== actual[i]) {
      return `at ${i}: expected ${JSON.stringify(expected.slice(i, i + 60))}, got ${JSON.stringify(actual.slice(i, i + 60))}`
    }
  }
  return `lengths differ: ${expected.length} vs ${actual.length}`
}

declare global {
  interface Window {
    __weft: { checks: Check[]; timings: Record<string, number[]> }
  }
}

window.__weft = { checks: checks(), timings: timings() }
performance.mark('candidate:interactive')
