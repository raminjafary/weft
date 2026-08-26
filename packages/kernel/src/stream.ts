import type { Resolver, TemplateIR, Values } from '@weft/ir'
import { fillerBytes } from './filler.ts'
import { anchorFor, splitAtSlots, type Splitter } from './split.ts'

const utf8 = new TextEncoder()

/** What fills a slot. A string is encoded; bytes are written as they are. */
export type SlotContent = Uint8Array | string

/** What streaming needs: the document, its values, and a resolver per slot. */
export interface Route {
  template: TemplateIR
  values: Values
  resolve?: Resolver | undefined
  /**
   * How to cut this document, when the flat splitter is not it: a route whose layouts are nested
   * carries `chainSplitter`. See `split-chain.ts`.
   *
   * `| undefined` is deliberate under `exactOptionalPropertyTypes`: the kernel copies this field
   * across from `KernelRoute` and being allowed to copy it unconditionally is two fewer branches on
   * the document request path, which has twelve bytes of headroom.
   */
  split?: Splitter | undefined
  /** One resolver per slot. Whatever it awaits is what the shell refused to wait for. */
  slots: Record<string, () => Promise<SlotContent>>
}

/** Whether a slow slot holds back the ones after it, or the fastest fills first. Derived, not declared. */
export type Order = 'in-order' | 'out-of-order'

/** The order, what wraps the document, and the fill script for out-of-order delivery. */
export interface StreamOptions {
  order: Order
  prelude?: SlotContent
  postlude?: SlotContent
  /**
   * Emitted once before the first fill. Defaults to the built-in filler, and that default is not
   * a convenience: `fillFor` emits a call to `__w`, so an out-of-order stream without a fill
   * mechanism produces markup that references a function nobody defined.
   *
   * It was optional, and `kernel.handle` did not pass it — so every out-of-order response the
   * kernel produced threw `__w is not defined` in the browser, six times on a four-slot page.
   * Nothing caught it because every test read the body as bytes. Supplying your own means
   * supplying something that defines `__w`.
   */
  filler?: SlotContent
}

function bytes(value: SlotContent): Uint8Array {
  return typeof value === 'string' ? utf8.encode(value) : value
}

/**
 * Two orders, and the difference between them is not a tuning knob.
 *
 * `in-order` streams each slot where it sits in the document. It needs no JavaScript at
 * all, and a slow slot holds back every slot after it.
 *
 * `out-of-order` sends the whole shell first with an anchor comment at each slot, then
 * fills whichever slot resolves first. Nothing waits on document order, and it costs a
 * fill mechanism — see the note in the kernel's spec about why that mechanism cannot be
 * declarative shadow DOM.
 */
export function streamRoute(route: Route, options: StreamOptions): ReadableStream<Uint8Array> {
  const { chunks, slots } = (route.split ?? splitAtSlots)(route.template, route.values, route.resolve)

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (value: SlotContent) => controller.enqueue(bytes(value))
      if (options.prelude) send(options.prelude)

      if (options.order === 'in-order') {
        for (let i = 0; i < chunks.length; i++) {
          send(chunks[i] as Uint8Array)
          const slot = slots[i]
          if (!slot) continue
          send(await resolveSlot(route, slot))
        }
      } else {
        for (let i = 0; i < chunks.length; i++) {
          send(chunks[i] as Uint8Array)
          const slot = slots[i]
          if (slot) send(anchorFor(slot))
        }
        if (slots.length) send(options.filler ?? fillerBytes())

        // Fastest first: the pipe is filled with whatever is ready, not with whatever
        // comes next in the document.
        const inflight = new Map<number, Promise<{ index: number; slot: string; content: Uint8Array }>>()
        slots.forEach((slot, index) => {
          inflight.set(
            index,
            resolveSlot(route, slot).then((content) => ({ index, slot, content })),
          )
        })
        while (inflight.size) {
          const next = await Promise.race(inflight.values())
          inflight.delete(next.index)
          send(fillFor(next.slot, next.content))
        }
      }

      if (options.postlude) send(options.postlude)
      controller.close()
    },
  })
}

async function resolveSlot(route: Route, slot: string): Promise<Uint8Array> {
  const producer = route.slots[slot]
  if (!producer) return new Uint8Array(0)
  return bytes(await producer())
}

/**
 * A region arrives as inert template content plus a call to move it. The content is not
 * inside a string literal, so nothing has to be escaped for JavaScript on the way.
 */
export function fillFor(slot: string, content: Uint8Array): Uint8Array {
  const open = utf8.encode(`<template data-w="${slot}">`)
  const close = utf8.encode(`</template><script>__w(${JSON.stringify(slot)})</script>`)
  const out = new Uint8Array(open.length + content.length + close.length)
  out.set(open, 0)
  out.set(content, open.length)
  out.set(close, open.length + content.length)
  return out
}
