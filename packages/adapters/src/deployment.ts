import type { ConfigPort, DeploymentPort } from '@weft/kernel'

/**
 * Which build is answering, and where it is running.
 *
 * The reason this is worth a port rather than three constants: every platform spells it
 * differently and most of them spell it in an environment variable the kernel is not allowed to
 * read. A revision is `GIT_SHA` on one host, a deployment id on another, `CF_VERSION_METADATA`
 * on a third, and nothing at all on a laptop — where the honest answer is `dev` rather than a
 * plausible-looking hash of nothing.
 *
 * What it is for, in order of how often it matters: a response header that says which build
 * served you, telemetry attributes that make two versions comparable during a rollout, and a
 * devtools page that answers "is this the code I just deployed" without a deploy log.
 *
 * What it is deliberately not for: cache keys. A revision in the key namespace would drop every
 * cached render on every deploy, and the entries that genuinely must not survive a deploy already
 * do not — a key contains the template's content address, so an edited fragment is a different
 * key by construction.
 */
export interface DeploymentOptions {
  revision?: string
  environment?: string
  region?: string
  instance?: string
}

export function staticDeployment(options: DeploymentOptions = {}): DeploymentPort {
  return {
    name: 'static',
    revision: options.revision ?? 'dev',
    environment: options.environment ?? 'development',
    ...(options.region ? { region: options.region } : {}),
    ...(options.instance ? { instance: options.instance } : {}),
  }
}

/**
 * The same, read from whatever the host happens to call it.
 *
 * The candidate lists are ordered most specific first, and every one of them is a name a real
 * platform uses. Nothing is invented: a deployment that sets none of them is `dev`, which is what
 * a laptop is, and saying so is more useful than a hash of the working directory.
 */
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

export interface HostDeploymentOptions extends DeploymentOptions {
  env?: Record<string, string | undefined>
  /** Read `WEFT_`-prefixed settings from a config port instead of the raw environment. */
  config?: ConfigPort
}

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
    // Shortened, because a revision is read by a person comparing two of them and forty
    // characters of hex is not read, it is scrolled past.
    revision: revision ? revision.slice(0, 12) : 'dev',
    environment: environment ?? 'development',
    ...(region ? { region } : {}),
    ...(instance ? { instance } : {}),
  }
}
