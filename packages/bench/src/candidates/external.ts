import { spawn } from 'node:child_process'
import type { Candidate, ServeHandle } from '../candidate.ts'

export interface ExternalConfig {
  id: string
  label: string
  mechanism: string
  /** Where the app serves. The scenario route is appended to the origin. */
  origin: string
  command?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  readyTimeoutMs?: number
}

async function waitForReady(origin: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError = 'never responded'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(origin, { method: 'GET' })
      if (res.ok || res.status < 500) {
        await res.arrayBuffer()
        return
      }
      lastError = `status ${res.status}`
    } catch (e) {
      lastError = (e as Error).message
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`E_EXTERNAL_NOT_READY: ${origin} (${lastError})`)
}

/**
 * Third-party candidates are configured, never vendored. A published claim about
 * beating another framework has to be reproducible against that framework's own app.
 */
export function externalCandidate(config: ExternalConfig): Candidate {
  return {
    id: config.id,
    label: config.label,
    mechanism: config.mechanism,
    thirdParty: true,
    unsupported: {
      'server-throughput': 'in-process rendering is not reachable across a process boundary',
      'update-bytes': 'update payloads are framework-internal; measure over HTTP instead',
    },
    async serve(scenario): Promise<ServeHandle> {
      let child: ReturnType<typeof spawn> | undefined
      if (config.command) {
        child = spawn(config.command, config.args ?? [], {
          cwd: config.cwd,
          env: { ...process.env, ...config.env },
          stdio: 'ignore',
          detached: false,
        })
      }
      await waitForReady(config.origin, config.readyTimeoutMs ?? 30_000)
      return {
        url: `${config.origin.replace(/\/$/, '')}${scenario.route}`,
        close: async () => {
          if (child && !child.killed) child.kill('SIGTERM')
        },
      }
    },
  }
}
