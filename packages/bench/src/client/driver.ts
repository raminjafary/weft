import { adopt, type Adopted } from '/runtime/adopt.ts'
import { applyDelta, type DeltaPayload } from '/runtime/delta.ts'
import { evaluate } from '/runtime/derived.ts'
import { signal } from '/runtime/signal.ts'
import type { ClientExpr, ClientTemplate, Json } from '/runtime/template.ts'

interface Config {
  template: ClientTemplate
  resident: Record<string, ClientTemplate>
  /** The server's render of the values the page was sent. */
  html: string
  /** The server's render of the values the delta moves to — the DOM adoption must reach. */
  expected: string
  delta: DeltaPayload
  /** The values the server rendered with, so a server-owned derived value can be checked. */
  values: Record<string, Json>
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
    const wiredHost = region(config.html)
    const signals = Object.fromEntries(bindings.map((binding) => [binding, signal(0 as never)]))
    adopt({ root: wiredHost, template: config.template, resident: config.resident, signals })
    const binding = bindings[0] as string
    const before = wiredHost.innerHTML
    signals[binding]!.set(4242 as never)
    out.push({
      name: 'a signal write reaches the DOM through the wiring table',
      ok: wiredHost.innerHTML !== before && wiredHost.innerHTML.includes('4242'),
      ...(wiredHost.innerHTML.includes('4242') ? {} : { detail: wiredHost.innerHTML.slice(0, 160) }),
    })
  }

  // A derived value is the client computing something the server rendered. The write
  // goes to the signal; what has to reach the DOM is the expression's answer.
  const drive = derivedDrive()
  if (drive) {
    const derivedHost = region(config.html)
    const signals = Object.fromEntries(drive.reads.map((id) => [id, signal(1 as never)]))
    adopt({ root: derivedHost, template: config.template, resident: config.resident, signals })
    const before = derivedHost.innerHTML
    signals[drive.reads[0] as string]!.set(77 as never)
    const expected = String(evaluate(drive.expr, (id) => signals[id]?.() as Json | undefined))
    const reached = derivedHost.innerHTML !== before && derivedHost.innerHTML.includes(expected)
    out.push({
      name: 'a derived value recomputes on the client and reaches the DOM',
      ok: reached,
      detail: reached ? `${drive.binding} = ${expected}` : derivedHost.innerHTML.slice(0, 160),
    })

    // The other half of the contract: what the client cannot compute, it must not touch.
    const server = serverOwned()
    if (server) {
      const rendered = String(evaluate(server.expr, (id) => config.values[id]))
      out.push({
        name: 'a derived value the client cannot compute is left as the server rendered it',
        ok: derivedHost.innerHTML.includes(rendered),
        detail: `${server.id} = ${rendered}`,
      })
    }
  }

  const crossing = instanceBindings()
  if (crossing.length) {
    const composedHost = region(config.html)
    const signals = Object.fromEntries(crossing.map((binding) => [binding, signal(0 as never)]))
    const parent = adopt({
      root: composedHost,
      template: config.template,
      resident: config.resident,
      signals,
    })
    out.push({
      name: 'a component instance is adopted as its own template',
      ok: Object.keys(parent.instances).length > 0,
      detail: `${Object.keys(parent.instances).length} instances`,
    })

    const before = composedHost.innerHTML
    for (const binding of crossing) signals[binding]!.set(31 as never)
    out.push({
      name: 'a signal handed to a component reaches the nodes inside it',
      ok: composedHost.innerHTML !== before && composedHost.innerHTML.includes('31'),
      detail: composedHost.innerHTML !== before ? 'written' : composedHost.innerHTML.slice(0, 160),
    })
  }

  for (const node of Array.from(document.body.children)) node.remove()
  return out
}

/** The refs an expression reads, in first-seen order. */
function refsOf(expr: ClientExpr, out: string[] = []): string[] {
  if (expr.k === 'ref') {
    if (!out.includes(expr.id)) out.push(expr.id)
  } else if (expr.k === 'un') refsOf(expr.a, out)
  else if (expr.k === 'bin') {
    refsOf(expr.a, out)
    refsOf(expr.b, out)
  }
  return out
}

/**
 * A wired derived binding and the signals behind it. The compiler only wires a derived
 * value that reaches a signal, so every ref that is not itself derived is one.
 */
function derivedDrive(): { binding: string; expr: ClientExpr; reads: string[] } | undefined {
  const decls = config.template.derived ?? []
  const ids = new Set(decls.map((d) => d.id))
  const binding = wiredBindings().find((b) => ids.has(b))
  const decl = decls.find((d) => d.id === binding)
  if (!binding || !decl) return undefined
  const reads = refsOf(decl.expr).filter((id) => !ids.has(id))
  return reads.length ? { binding, expr: decl.expr, reads } : undefined
}

/** A derived value with no wiring entry: the server computed it and owns it. */
function serverOwned(): { id: string; expr: ClientExpr } | undefined {
  const wired = new Set(wiredBindings())
  return (config.template.derived ?? []).find((d) => !wired.has(d.id))
}

/**
 * The parent bindings that feed a component instance. A signal handed to one has to reach
 * the child's nodes through the child's own wiring table, renamed on the way in.
 */
function instanceBindings(): string[] {
  const out = new Set<string>()
  for (const hole of config.template.holes) {
    if (hole.kind !== 'component') continue
    for (const binding of Object.values(hole.props ?? {})) out.add(binding)
  }
  return [...out]
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
    // The same write, but through an expression the client evaluates on the way. This is
    // what the graph rewrite is for, and it is measured next to the direct write rather
    // than in place of it.
    ...(derivedDrive()
      ? {
          derive: measure(config.batch * 5000, () => {
            const host = region(config.html)
            const drive = derivedDrive()!
            const signals = Object.fromEntries(drive.reads.map((id) => [id, signal(0 as never)]))
            adopt({ root: host, template: config.template, resident: config.resident, signals })
            const first = signals[drive.reads[0] as string]!
            let n = 0
            return () => first.set(++n as never)
          }),
        }
      : {}),
  }
  for (const node of Array.from(document.body.children)) node.remove()
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
