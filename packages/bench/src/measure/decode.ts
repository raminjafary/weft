import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import { encodeStream, frame, type Frame } from '@weftjs/warp'
import { summarize, type Summary } from '../stats.ts'
import { launchEngine, type EngineName } from './browser.ts'
import { reachableUrl } from './device.ts'

/** Whether decoding a batch of frames is worth moving off the main thread. See `spec/FINDINGS.md`. */
export interface DecodeRun {
  engine: EngineName
  engineVersion: string
  rows: number
  bytes: number
  iterations: number
  main: Summary
  worker: Summary
}

async function serveModule(path: string): Promise<string> {
  return stripTypeScriptTypes(await readFile(path, 'utf8'), { mode: 'strip' })
}

/** A delta of `rows` changed values, which is the frame a large page's update actually is. */
function batch(rows: number): Frame[] {
  const changed: Record<string, string> = {}
  for (let i = 0; i < rows; i++) changed[`row${i}.price`] = `${(1000 + i).toLocaleString('en-US')} IQD`
  const body = new TextEncoder().encode(JSON.stringify(changed))
  return [
    frame(
      'DELTA',
      { s: 'body', tpl: 'a'.repeat(32), base: 'b'.repeat(16), next: 'c'.repeat(16) },
      body,
      true,
    ),
    frame('SIGNAL', { id: 'qty', v: '3' }),
  ]
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>decode</title></head><body>
<script type="module">
import { createBinaryDecoder } from '/warp/index.ts'

const decoder = new TextDecoder()
const worker = new Worker('/worker.ts', { type: 'module' })
const pending = new Map()
let next = 1
worker.addEventListener('message', (event) => {
  const settle = pending.get(event.data.id)
  if (settle) {
    pending.delete(event.data.id)
    settle(event.data.frames.length)
  }
})

function decodeHere(bytes) {
  const frames = createBinaryDecoder({ expect: 'down' }).push(bytes)
  for (const f of frames) {
    if (f.body && f.bodyIsText) JSON.parse(decoder.decode(f.body))
  }
  return frames.length
}

function decodeThere(bytes) {
  const id = next++
  const copy = bytes.slice()
  return new Promise((resolve) => {
    pending.set(id, resolve)
    worker.postMessage({ id, bytes: copy }, [copy.buffer])
  })
}

window.measure = async (base64, iterations) => {
  const raw = atob(base64)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)

  // Warm both paths: a first decode and a first postMessage each pay a one-time cost.
  decodeHere(bytes)
  await decodeThere(bytes)

  const main = []
  const off = []
  for (let i = 0; i < iterations; i++) {
    const a = performance.now()
    decodeHere(bytes)
    main.push(performance.now() - a)
    const b = performance.now()
    await decodeThere(bytes)
    off.push(performance.now() - b)
  }
  return { main, worker: off, frames: decodeHere(bytes) }
}
</script></body></html>`

const WORKER = `import { createBinaryDecoder } from '/warp/index.ts'

const decoder = new TextDecoder()

self.addEventListener('message', (event) => {
  const frames = createBinaryDecoder({ expect: 'down' }).push(new Uint8Array(event.data.bytes))
  for (const f of frames) {
    if (f.body && f.bodyIsText) JSON.parse(decoder.decode(f.body))
  }
  // Cloned back, not transferred: the frames are objects. See spec/FINDINGS.md.
  self.postMessage({ id: event.data.id, frames })
})
`

export async function measureDecode(
  engine: EngineName,
  rows: number,
  iterations: number,
): Promise<DecodeRun> {
  const warpDir = fileURLToPath(new URL('../../../warp/src/', import.meta.url))
  const bytes = new Uint8Array(encodeStream(batch(rows)))

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] as string
    const send = (body: string, type: string): void => {
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
      res.end(body)
    }
    if (path.startsWith('/warp/')) {
      void serveModule(warpDir + path.slice('/warp/'.length))
        .then((code) => send(code, 'text/javascript; charset=utf-8'))
        .catch(() => {
          res.writeHead(404).end()
        })
      return
    }
    if (path === '/worker.ts') {
      send(WORKER, 'text/javascript; charset=utf-8')
      return
    }
    send(PAGE, 'text/html; charset=utf-8')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address === 'string' || !address)
    throw new Error(
      'E_NO_ADDRESS: the server reported no TCP address after listening, so nothing can be told where to connect',
    )

  const browser = await launchEngine(engine)
  try {
    const page = await (await browser.newContext()).newPage()
    await page.goto(reachableUrl(engine, `http://127.0.0.1:${address.port}/`), { waitUntil: 'load' })
    const encoded = Buffer.from(bytes).toString('base64')
    const measured = (await page.evaluate(`window.measure(${JSON.stringify(encoded)}, ${iterations})`)) as {
      main: number[]
      worker: number[]
    }

    return {
      engine,
      engineVersion: browser.version(),
      rows,
      bytes: bytes.length,
      iterations,
      main: summarize(measured.main),
      worker: summarize(measured.worker),
    }
  } finally {
    await browser.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/** The comparison, or the reason there is not one — a zero-median decode must not print `Infinity×`. See `spec/FINDINGS.md`. */
function verdict(run: DecodeRun): string {
  if (run.main.p50 === 0) {
    return (
      `The main-thread decode is under this engine's clock resolution and the worker's floor is not.` +
      `\n  A postMessage and a structured clone back are the whole of the difference;`
    )
  }
  const ratio = run.worker.p50 / run.main.p50
  return (
    `${ratio >= 1 ? `${ratio.toFixed(1)}× slower off-thread` : `${(1 / ratio).toFixed(1)}× faster off-thread`}.` +
    ` The worker's floor is a postMessage and a structured clone back;`
  )
}

export function formatDecode(run: DecodeRun): string {
  return [
    '',
    `  ${run.engine} ${run.engineVersion} — a DELTA of ${run.rows} changed values, ${run.bytes} B on the wire`,
    `  ${run.iterations} samples each, alternated, both paths warmed first`,
    '',
    `  main thread    p50 ${run.main.p50.toFixed(3)} ms   p95 ${run.main.p95.toFixed(3)} ms`,
    `  worker         p50 ${run.worker.p50.toFixed(3)} ms   p95 ${run.worker.p95.toFixed(3)} ms`,
    '',
    `  ${verdict(run)} a decode has to be`,
    '  larger than that floor before moving it is anything but a cost.',
    '',
  ].join('\n')
}
