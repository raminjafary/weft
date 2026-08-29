import type { ConfigPort } from '@weftjs/kernel'

/**
 * What the deployment was configured with. Two implementations, genuinely different shapes: a
 * Node process reads its environment, a Worker is handed an `env` object per request. See
 * `ConfigPort` in `@weftjs/kernel`.
 */
export class ConfigError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(`${code} — ${message}`)
    this.name = 'ConfigError'
    this.code = code
  }
}

function port(name: string, read: (key: string) => string | undefined, keys: () => string[]): ConfigPort {
  return {
    name,
    get: read,
    keys,
    required(key) {
      const value = read(key)
      if (value === undefined || value === '') {
        throw new ConfigError(
          'E_CONFIG_MISSING',
          `${key} is required and this deployment does not set it. Known keys: ${keys().join(', ') || 'none'}`,
        )
      }
      return value
    },
  }
}

/** Settings from an object: a Worker's `env`, a test, or a config file that already read them. */
export function staticConfig(values: Record<string, string | undefined>): ConfigPort {
  return port(
    'static',
    (key) => values[key],
    () => Object.keys(values).sort(),
  )
}

/** Which environment variables are readable, and what a missing one does. */
export interface EnvConfigOptions {
  /**
   * Only keys under this prefix are visible, and they are asked for without it. Defaults to
   * `WEFT_`: no prefix would hand every fragment the whole environment.
   */
  prefix?: string
  /** The environment to read. Defaults to this process's. */
  env?: Record<string, string | undefined>
}

/** Configuration from the environment, through a declared allow-list — a render reading `process.env` directly is a read the compiler never saw. */
export function envConfig(options: EnvConfigOptions = {}): ConfigPort {
  const prefix = options.prefix ?? 'WEFT_'
  const env =
    options.env ??
    (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ??
    {}
  const visible = (): string[] =>
    Object.keys(env)
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
      .sort()
  return port('env', (key) => env[`${prefix}${key}`], visible)
}
