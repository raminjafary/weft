import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import { clientView, render, TEMPLATE_IR_VERSION, type TemplateIR } from '@weft/ir'
import { heldBy, isHeld } from '@weft/client'
import { encodeStream, frame, negotiate, type Frame } from '@weft/warp'
import { serverCapabilities } from '@weft/kernel'
import { compileScenario, withRows } from '../compiled.ts'
import type { Scenario } from '../workloads/index.ts'
import { launchEngine, type EngineName } from './browser.ts'
import { reachableUrl } from './device.ts'

const decoder = new TextDecoder()
const utf8 = new TextEncoder()

export interface Visit {
  /** Milliseconds from navigation start to the interactive mark. */
  interactive: number
  decodeMs: number
  openMs: number
  putMs: number
  adoptMs: number
  bootMs: number
  templatesSent: number
  templatesHeld: number
  frameBytes: number
  durableStorage: boolean
}

export interface RepeatVisitRun {
  engine: EngineName
  engineVersion: string
  cold: Visit[]
  repeat: Visit[]
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return Buffer.from(s, 'binary').toString('base64')
}

async function serveModule(path: string): Promise<string> {
  return stripTypeScriptTypes(await readFile(path, 'utf8'), { mode: 'strip' })
}

function cookieValue(header: string | undefined, name: string): string {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return ''
}

/**
 * A visit, served the way the design describes: the document carries the first frames, and
 * a TPL frame is sent only for a template the client does not already hold. What a repeat
 * visit avoids is therefore visible in the response itself, not only in a timer.
 */
export async function measureRepeatVisit(
  scenario: Scenario,
  engine: EngineName,
  iterations: number,
): Promise<RepeatVisitRun> {
  const compiled = await compileScenario(scenario)
  const values = withRows(compiled, scenario.values(), scenario.rows())
  const html = decoder.decode(render(compiled.root, values, compiled.resolve))
  const templates: TemplateIR[] = compiled.row ? [compiled.row, compiled.root] : [compiled.root]

  const runtimeDir = fileURLToPath(new URL('../../../client/src/', import.meta.url))
  const warpDir = fileURLToPath(new URL('../../../warp/src/', import.meta.url))
  const bootFile = fileURLToPath(new URL('../client/boot.ts', import.meta.url))

  let lastFrameBytes = 0
  let lastSent = 0

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] as string
    // Nothing is cacheable, so a repeat visit cannot be flattered by the HTTP cache
    // holding the runtime modules. What is left is the resident templates themselves.
    const send = (body: string, type: string) => {
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
      res.end(body)
    }

    if (path === '/boot.ts') {
      void serveModule(bootFile).then((code) => send(code, 'text/javascript; charset=utf-8'))
      return
    }
    if (path.startsWith('/runtime/') || path.startsWith('/warp/')) {
      const dir = path.startsWith('/warp/') ? warpDir : runtimeDir
      const name = path.slice(path.indexOf('/', 1) + 1)
      void serveModule(dir + name)
        .then((code) => send(code, 'text/javascript; charset=utf-8'))
        .catch(() => {
          res.writeHead(404)
          res.end()
        })
      return
    }

    const held = heldBy(cookieValue(req.headers.cookie, 'weft-resident'))
    const settled = negotiate(
      { warp: '1.0.0', ir: TEMPLATE_IR_VERSION, forms: ['html', 'delta'], transport: 'stream' },
      serverCapabilities(),
    )

    const frames: Frame[] = [
      frame('WARP', {
        spec: settled.spec,
        v: settled.warp,
        ir: settled.ir,
        forms: settled.forms.join(','),
        strategy: settled.strategy,
      }),
      frame('SHELL', { route: scenario.route, tpl: compiled.root.version }),
    ]
    let sent = 0
    for (const template of templates) {
      if (isHeld(held, template.version)) continue
      frames.push(
        frame('TPL', { tpl: template.version }, utf8.encode(JSON.stringify(clientView(template))), true),
      )
      sent++
    }

    const stream = encodeStream(frames)
    lastFrameBytes = stream.length
    lastSent = sent

    send(
      `<!doctype html><html><head><meta charset="utf-8"><title>${scenario.id}</title></head><body>
<div id="region">${html}</div>
<script type="application/warp" id="frames">${toBase64(stream)}</script>
<script type="module" src="/boot.ts"></script>
</body></html>`,
      'text/html; charset=utf-8',
    )
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address === 'string' || address === null)
    throw new Error(
      'E_NO_ADDRESS: the server reported no TCP address after listening, so nothing can be told where to connect',
    )
  const url = reachableUrl(engine, `http://127.0.0.1:${address.port}/`)

  const browser = await launchEngine(engine)
  const cold: Visit[] = []
  const repeat: Visit[] = []

  try {
    for (let i = 0; i < iterations; i++) {
      // A fresh context is a first visit: no cookie, no IndexedDB.
      const context = await browser.newContext()
      const tab = await context.newPage()
      try {
        cold.push(await visit(tab, url, () => ({ frameBytes: lastFrameBytes, sent: lastSent })))
        repeat.push(await visit(tab, url, () => ({ frameBytes: lastFrameBytes, sent: lastSent })))
      } finally {
        await tab.close()
        await context.close()
      }
    }
    return { engine, engineVersion: browser.version(), cold, repeat }
  } finally {
    await browser.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

interface PageLike {
  goto(url: string, opts?: unknown): Promise<unknown>
  evaluate<T>(fn: string): Promise<T>
  close(): Promise<void>
}

async function visit(
  tab: PageLike,
  url: string,
  response: () => { frameBytes: number; sent: number },
): Promise<Visit> {
  await tab.goto(url, { waitUntil: 'load' })
  const measured = await tab.evaluate<{ interactive: number; boot: Record<string, number | boolean> }>(
    `(async () => {
      for (let i = 0; i < 200 && !window.__boot; i++) await new Promise((r) => setTimeout(r, 5))
      const mark = performance.getEntriesByName('candidate:interactive')[0]
      return { interactive: mark ? mark.startTime : NaN, boot: window.__boot }
    })()`,
  )
  const { frameBytes, sent } = response()
  return {
    interactive: measured.interactive,
    decodeMs: Number(measured.boot?.decodeMs ?? NaN),
    openMs: Number(measured.boot?.openMs ?? NaN),
    putMs: Number(measured.boot?.putMs ?? NaN),
    adoptMs: Number(measured.boot?.adoptMs ?? NaN),
    bootMs: Number(measured.boot?.totalMs ?? NaN),
    templatesSent: sent,
    templatesHeld: Number(measured.boot?.held ?? 0),
    frameBytes,
    durableStorage: Boolean(measured.boot?.durable),
  }
}
