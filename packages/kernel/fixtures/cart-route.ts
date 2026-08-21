import { fileURLToPath } from 'node:url'
import { compileFiles } from '@weft/compiler'
import { render, type TemplateIR, type Values } from '@weft/ir'
import type { KernelRoute, KernelSlot } from '../src/kernel.ts'
import type { PreloadLink } from '../src/ports.ts'

/**
 * A route assembled from real compiler output.
 *
 * The unit tests build a `TemplateIR` by hand, which is the right thing for asserting one
 * mechanism and the wrong thing for believing the whole path works. Nothing here is
 * hand-written: the shell, the slots, and every effect set come out of the compiler, so a
 * change to lowering or to effect inference breaks these fixtures rather than quietly
 * agreeing with a stale copy.
 *
 * It is also the same discipline the benchmark harness already uses — measure emitted IR,
 * never a hand-written one.
 */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url))

export const SHELL = 'packages/compiler/fixtures/shell.tsx'
/** Every keyable read in one fragment: shared, wide key, needs a TTL. */
export const KEYED = 'packages/compiler/fixtures/keyed.tsx'
/** One identity read: private, whatever else it does. */
export const PRIVATE = 'packages/compiler/fixtures/private.tsx'
/** `ctx.raw()`: private, and no key at all. */
export const OPAQUE = 'packages/compiler/fixtures/opaque.tsx'
/** Value-projectable throughout, so `delta` is derivable and a surgical refresh is possible. */
export const LINES = 'packages/compiler/fixtures/lines.tsx'

/** The id the compiler gives a default export, which is what a plan names. */
export function fragmentId(file: string, exported = 'default'): string {
  return `${file}#${exported}`
}

export interface CompiledFixture {
  /** Module and export, as the compiler names it. Stable across content changes. */
  id: string
  entry: TemplateIR
  templates: TemplateIR[]
  resolve(version: string): TemplateIR | undefined
}

const cache = new Map<string, CompiledFixture>()

export async function compileFixture(file: string): Promise<CompiledFixture> {
  const hit = cache.get(file)
  if (hit) return hit
  const { modules } = await compileFiles([file], { root: ROOT })
  const fragment = modules[0]?.fragments[0]
  if (!fragment) throw new Error(`E_NO_FRAGMENT: ${file} has no fragment() export`)
  const byVersion = new Map(fragment.templates.map((t) => [t.version, t]))
  const compiled: CompiledFixture = {
    id: fragment.entry.id,
    entry: fragment.entry,
    templates: fragment.templates,
    resolve: (version) => byVersion.get(version),
  }
  cache.set(file, compiled)
  return compiled
}

export async function compileFixtures(files: readonly string[]): Promise<Record<string, CompiledFixture>> {
  const out: Record<string, CompiledFixture> = {}
  for (const file of files) out[file] = await compileFixture(file)
  return out
}

export const SHELL_VALUES: Values = {
  title: 'Your cart — Souq',
  cssVersion: '/a/route.a91f3c.css',
  runtimeVersion: '/a/runtime.c01277.js',
  flags: '3f2a',
  cartCount: 3,
  cartLines: '',
  recs: '',
  footer: '© 2026 Souq',
}

export const KEYED_VALUES: Values = {
  variant: 'v2',
  currency: 'IQD',
  tier: 'gold',
  region: 'baghdad',
  sort: 'price',
  locale: 'ar-iq',
  device: 'mobile',
  asOf: 1_770_000_000_000,
}

export const PRIVATE_VALUES: Values = { user: 'Ramin', currency: 'IQD' }

export const CRITICAL: PreloadLink[] = [
  { href: '/a/route.a91f3c.css', as: 'style', rel: 'preload' },
  { href: '/a/runtime.c01277.js', as: 'script', rel: 'modulepreload' },
]

async function wait(ms: number | undefined): Promise<void> {
  if (ms) await new Promise((resolve) => setTimeout(resolve, ms))
}

export interface CartRouteOptions {
  /** Milliseconds each slot waits before resolving, so streaming order is observable. */
  delays?: Partial<Record<'cartLines' | 'recs', number>>
  /** Applied to the keyed slot, which is the only one with a policy. */
  ttlMs?: number
  order?: KernelRoute['order']
}

/**
 * The shell's two slot holes filled by two real fragments with deliberately different cache
 * classes: one shared with a wide key, one private. That pairing is the point — the document's
 * `Vary` is the union of theirs and its class is the stricter of the two, and neither of those
 * is stated anywhere in this file.
 */
export async function cartRoute(options: CartRouteOptions = {}): Promise<KernelRoute> {
  const [shell, keyed, priv] = await Promise.all([
    compileFixture(SHELL),
    compileFixture(KEYED),
    compileFixture(PRIVATE),
  ])

  const cartLines: KernelSlot = {
    name: 'cartLines',
    id: keyed.id,
    version: keyed.entry.version,
    effects: keyed.entry.effects,
    prio: 1,
    policy: { class: 'public', ttlMs: options.ttlMs ?? 60_000, tags: ['prices'] },
    placeholder: new TextEncoder().encode('<p class="skeleton"></p>'),
    onExceed: 'placeholder',
    render: async () => {
      await wait(options.delays?.cartLines)
      return render(keyed.entry, KEYED_VALUES, keyed.resolve)
    },
  }

  const recs: KernelSlot = {
    name: 'recs',
    id: priv.id,
    version: priv.entry.version,
    effects: priv.entry.effects,
    render: async (ctx) => {
      await wait(options.delays?.recs)
      return render(
        priv.entry,
        { ...PRIVATE_VALUES, currency: ctx.cookie('currency') ?? 'IQD' },
        priv.resolve,
      )
    },
  }

  return {
    path: '/cart',
    template: shell.entry,
    values: SHELL_VALUES,
    resolve: shell.resolve,
    critical: CRITICAL,
    order: options.order ?? 'out-of-order',
    slots: [cartLines, recs],
  }
}
