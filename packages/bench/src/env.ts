import { execFileSync } from 'node:child_process'
import { arch, cpus, freemem, loadavg, platform, release, totalmem } from 'node:os'

export interface Environment {
  when: string
  node: string
  v8: string
  platform: string
  release: string
  arch: string
  cpu: string
  cores: number
  memoryGb: number
  freeMemoryGb: number
  commit: string | null
  /** Whether the machine looked busy enough to distrust the numbers. */
  loadAverage: number[]
}

export function environment(): Environment {
  const list = cpus()
  return {
    when: new Date().toISOString(),
    node: process.version,
    v8: process.versions.v8,
    platform: platform(),
    release: release(),
    arch: arch(),
    cpu: list[0]?.model ?? 'unknown',
    cores: list.length,
    memoryGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    freeMemoryGb: Math.round((freemem() / 1024 ** 3) * 10) / 10,
    commit: gitCommit(),
    loadAverage: loadavg().map((n) => Math.round(n * 100) / 100),
  }
}

function gitCommit(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}
