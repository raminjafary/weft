import type { ConfigPort } from '@weft/kernel'

/**
 * What the deployment was configured with.
 *
 * Two implementations because the two shapes are genuinely different, not because one is a test
 * double: a Node process reads its environment, and a Worker is handed an `env` object per request
 * and has no ambient environment at all. Both answer the same three questions, which is what
 * lets everything above them stop caring.
 *
 * A setting is not a tracked read and cannot enter a cache key — see `ConfigPort`. The rule has
 * teeth on this side too: `required` refuses by name rather than returning a default, because a
 * deployment missing its database URL should fail where it is configured rather than render a
 * page that quietly talks to nothing.
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
   * Only keys under this prefix are visible, and they are asked for without it.
   *
   * The default is `WEFT_`, and the default is not tidiness. A config port with no prefix hands
   * every fragment of an application the whole environment — every credential the process was
   * started with, including the ones belonging to something else entirely — through an API whose
   * whole job is to be easy to call.
   */
  prefix?: string
  /** The environment to read. Defaults to this process's. */
  env?: Record<string, string | undefined>
}

/**
 * Configuration from the environment, through a declared allow-list.
 *
 * A port rather than `process.env` directly, because a render reading the environment is a read the
 * compiler never saw — so this is bound once and what it exposes is written down.
 */
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
