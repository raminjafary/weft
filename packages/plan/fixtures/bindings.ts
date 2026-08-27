import type { Values } from '@weftjs/ir'
import { createRouter, type Router, type RouteResolver } from '@weftjs/kernel'
import {
  compileFixture,
  CRITICAL,
  KEYED,
  KEYED_VALUES,
  LINES,
  OPAQUE,
  PRIVATE,
  SHELL,
  SHELL_VALUES,
} from '../../kernel/fixtures/cart-route.ts'
import { routeEntry, type GuardHandler, type RouteBindings } from '../src/lower.ts'
import { cart, facts, product, quiet } from './cart.ts'

/**
 * What a plan needs beyond itself: the compiled fragments, the values each one renders with,
 * and a handler per declared guard.
 *
 * This is deliberately the only place an author writes a function. The plan says where things
 * go, the compiler says what they read, and this says what they render — three files, no
 * overlap, and nothing stated twice.
 */
const utf8 = new TextEncoder()

const rows = (sku: string): Values =>
  [
    { name: `${sku} — 5kg`, qty: 1, total: '12,000 IQD' },
    { name: `${sku} — 1kg`, qty: 2, total: '3,500 IQD' },
  ] as never

/** A guard is phase A by construction, so this runs before a byte leaves. */
export const guards: Record<string, GuardHandler> = {
  'session.required': (ctx) => Boolean(ctx.cookie('sid')),
}

export async function cartBindings(): Promise<RouteBindings> {
  const [shell, keyed, priv] = await Promise.all([
    compileFixture(SHELL),
    compileFixture(KEYED),
    compileFixture(PRIVATE),
  ])
  return {
    shell: { entry: shell.entry, resolve: shell.resolve },
    shellValues: () => SHELL_VALUES,
    critical: CRITICAL,
    guards,
    slots: {
      cartLines: {
        fragment: { entry: keyed.entry, resolve: keyed.resolve },
        values: (ctx) => ({ ...KEYED_VALUES, currency: ctx.cookie('currency') ?? 'IQD' }),
        placeholder: utf8.encode('<p class="skeleton"></p>'),
      },
      recs: {
        fragment: { entry: priv.entry, resolve: priv.resolve },
        values: async (ctx) => ({
          user: (await ctx.user()) ?? 'guest',
          currency: ctx.cookie('currency') ?? 'IQD',
        }),
      },
    },
  }
}

export async function productBindings(): Promise<RouteBindings> {
  const [shell, lines, opaque] = await Promise.all([
    compileFixture(SHELL),
    compileFixture(LINES),
    compileFixture(OPAQUE),
  ])
  const listHole = lines.entry.holes.find((hole) => hole.kind === 'list')
  if (!listHole) throw new Error('E_NO_LIST_HOLE: lines.tsx should lower to a list hole')

  return {
    shell: { entry: shell.entry, resolve: shell.resolve },
    // The param reaches the shell as data, and the slot as a read — which is why the same
    // value can title the page and key the fragment without being fetched twice.
    shellValues: (params) => ({ ...SHELL_VALUES, title: `${params.sku} — Souq` }),
    critical: CRITICAL,
    slots: {
      cartLines: {
        fragment: { entry: lines.entry, resolve: lines.resolve },
        values: (_ctx, params) => ({ [listHole.binding]: rows(params.sku ?? 'unknown') }),
      },
      recs: {
        fragment: { entry: opaque.entry, resolve: opaque.resolve },
        values: (ctx) => ({ banner: ctx.raw((f) => f.url.pathname) }),
      },
    },
  }
}

export async function quietBindings(): Promise<RouteBindings> {
  const [shell, lines] = await Promise.all([compileFixture(SHELL), compileFixture(LINES)])
  const listHole = lines.entry.holes.find((hole) => hole.kind === 'list')
  if (!listHole) throw new Error('E_NO_LIST_HOLE: lines.tsx should lower to a list hole')
  const binding = {
    fragment: { entry: lines.entry, resolve: lines.resolve },
    values: () => ({ [listHole.binding]: rows('rice') }),
  }
  return {
    shell: { entry: shell.entry, resolve: shell.resolve },
    shellValues: () => SHELL_VALUES,
    slots: { cartLines: binding, recs: binding },
  }
}

/** The whole table: three plans, lowered, in one router the kernel can be handed. */
export async function routes(): Promise<Router<RouteResolver>> {
  const context = { facts: await facts() }
  return createRouter([
    routeEntry(cart, context, await cartBindings()),
    routeEntry(product, context, await productBindings()),
    routeEntry(quiet, context, await quietBindings()),
  ])
}
