import { adopt } from '/runtime/adopt.ts'
import { digest, openResident } from '/runtime/resident.ts'
import type { ClientTemplate, Resident } from '/runtime/template.ts'
import { createBinaryDecoder } from '/warp/codec.ts'
import { str } from '/warp/frames.ts'

/**
 * What a visit actually does: decode the frames the document arrived with, take the
 * templates it already holds out of storage, store whatever the server had to send, and
 * adopt. On a repeat visit the server sends no TPL frames at all, so the only work left
 * is the adoption.
 */
function bytesFrom(base64: string): Uint8Array {
  const raw = atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

interface BootResult {
  entry: string
  received: number
  held: number
  durable: boolean
  /** Each phase separately, so a repeat visit's win can be attributed rather than asserted. */
  decodeMs: number
  openMs: number
  putMs: number
  adoptMs: number
  totalMs: number
}

async function boot(): Promise<BootResult> {
  const start = performance.now()
  const framesElement = document.getElementById('frames')
  const decoder = createBinaryDecoder({ expect: 'down' })
  const frames = decoder.push(bytesFrom((framesElement?.textContent ?? '').trim()))
  decoder.end()
  const decodeMs = performance.now() - start

  const openStart = performance.now()
  const store = await openResident()
  const resident: Resident = await store.all()
  const openMs = performance.now() - openStart
  const held = Object.keys(resident).length

  let entry = ''
  let received = 0
  const puts: Promise<void>[] = []

  const putStart = performance.now()
  for (const frame of frames) {
    if (frame.kind === 'SHELL') {
      entry = str(frame, 'tpl') ?? ''
      continue
    }
    if (frame.kind === 'TPL' && frame.body) {
      const template = JSON.parse(new TextDecoder().decode(frame.body)) as ClientTemplate
      resident[template.version] = template
      puts.push(store.put(template))
      received++
    }
  }
  await Promise.all(puts)
  const putMs = performance.now() - putStart

  const template = resident[entry]
  const root = document.getElementById('region')
  const adoptStart = performance.now()
  if (template && root) adopt({ root, template, resident })
  const adoptMs = performance.now() - adoptStart

  document.cookie = `weft-resident=${digest(Object.keys(resident))}; path=/; max-age=600; SameSite=Lax`

  performance.mark('candidate:interactive')
  const totalMs = performance.now() - start
  performance.measure('weft:boot', { start, end: performance.now() })
  return { entry, received, held, durable: store.durable, decodeMs, openMs, putMs, adoptMs, totalMs }
}

declare global {
  interface Window {
    __boot: BootResult
  }
}

window.__boot = await boot()
