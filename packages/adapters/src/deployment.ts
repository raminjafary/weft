import type { ConfigPort, DeploymentPort } from '@weftjs/kernel'

/**
 * Which build is answering, and where it is running. See `DeploymentPort` in `@weftjs/kernel`.
 * Deliberately not for cache keys: a key already contains the template's content address.
 */
export interface DeploymentOptions {
  revision?: string
  environment?: string
  region?: string
  instance?: string
}

/** A deployment that knows its own identity because somebody wrote it down. */
export function staticDeployment(options: DeploymentOptions = {}): DeploymentPort {
  return {
    name: 'static',
    revision: options.revision ?? 'dev',
    environment: options.environment ?? 'development',
    ...(options.region ? { region: options.region } : {}),
    ...(options.instance ? { instance: options.instance } : {}),
  }
}

/** The same, read from whatever the host happens to call it. Ordered most specific first. */
const REVISION = [
  'WEFT_REVISION',
  'GIT_SHA',
  'GIT_COMMIT',
  'VERCEL_GIT_COMMIT_SHA',
  'CF_VERSION_ID',
  'RENDER_GIT_COMMIT',
  'SOURCE_VERSION',
]
const ENVIRONMENT = ['WEFT_ENV', 'NODE_ENV', 'VERCEL_ENV', 'ENVIRONMENT']
const REGION = ['WEFT_REGION', 'FLY_REGION', 'AWS_REGION', 'VERCEL_REGION', 'CF_REGION']
const INSTANCE = ['WEFT_INSTANCE', 'FLY_ALLOC_ID', 'HOSTNAME', 'DYNO']

function first(env: Record<string, string | undefined>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]
    if (value) return value
  }
  return undefined
}

/** Where this deployment thinks it is, when the host tells it rather than the config. */
export interface HostDeploymentOptions extends DeploymentOptions {
  env?: Record<string, string | undefined>
  /** Read `WEFT_`-prefixed settings from a config port instead of the raw environment. */
  config?: ConfigPort
}

/** A deployment that reads its identity from the platform's own variables. */
export function hostDeployment(options: HostDeploymentOptions = {}): DeploymentPort {
  const env =
    options.env ??
    (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ??
    {}
  const configured = (key: string): string | undefined => options.config?.get(key)
  const revision = options.revision ?? configured('REVISION') ?? first(env, REVISION)
  const environment = options.environment ?? configured('ENV') ?? first(env, ENVIRONMENT)
  const region = options.region ?? configured('REGION') ?? first(env, REGION)
  const instance = options.instance ?? configured('INSTANCE') ?? first(env, INSTANCE)
  return {
    name: 'host',
    // Shortened: forty characters of hex is not read, it is scrolled past.
    revision: revision ? revision.slice(0, 12) : 'dev',
    environment: environment ?? 'development',
    ...(region ? { region } : {}),
    ...(instance ? { instance } : {}),
  }
}
