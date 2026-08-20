import { Agent, request } from 'node:http'

export interface HttpSample {
  ttfbHeaders: number
  ttfbBody: number
  ttlb: number
  bytes: number
  status: number
  reusedSocket: boolean
}

export interface HttpOptions {
  iterations: number
  warmup: number
  /** Warm measures the steady state; cold pays TCP setup on every iteration. */
  connection: 'warm' | 'cold'
}

async function sampleOnce(url: string, agent: Agent): Promise<HttpSample> {
  const target = new URL(url)
  return new Promise<HttpSample>((resolve, reject) => {
    const start = performance.now()
    let headersAt = NaN
    let firstByteAt = NaN
    let bytes = 0
    let reusedSocket = false

    const req = request(
      {
        agent,
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: { 'accept-encoding': 'identity' },
      },
      (res) => {
        headersAt = performance.now()
        res.on('data', (chunk: Buffer) => {
          if (Number.isNaN(firstByteAt)) firstByteAt = performance.now()
          bytes += chunk.length
        })
        res.on('end', () => {
          const end = performance.now()
          resolve({
            ttfbHeaders: headersAt - start,
            ttfbBody: (Number.isNaN(firstByteAt) ? headersAt : firstByteAt) - start,
            ttlb: end - start,
            bytes,
            status: res.statusCode ?? 0,
            reusedSocket,
          })
        })
        res.on('error', reject)
      },
    )
    req.on('socket', (socket) => {
      reusedSocket = socket.bytesWritten > 0
    })
    req.on('error', reject)
    req.end()
  })
}

export async function measureHttp(url: string, options: HttpOptions): Promise<HttpSample[]> {
  const warmAgent = new Agent({ keepAlive: true, maxSockets: 1 })
  const agentFor = () =>
    options.connection === 'warm' ? warmAgent : new Agent({ keepAlive: false, maxSockets: 1 })

  for (let i = 0; i < options.warmup; i++) await sampleOnce(url, agentFor())

  const samples: HttpSample[] = []
  for (let i = 0; i < options.iterations; i++) {
    const agent = agentFor()
    samples.push(await sampleOnce(url, agent))
    if (options.connection === 'cold') agent.destroy()
  }
  warmAgent.destroy()

  const bad = samples.find((s) => s.status !== 200)
  if (bad) throw new Error(`E_BAD_STATUS: ${url} responded ${bad.status}`)
  return samples
}
