#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { basename, resolve } from 'node:path'
import process from 'node:process'
import { build, formatReport } from './build.ts'
import { loadBuild } from './build.ts'
import { loadConfig } from './config.ts'
import { discover } from './convention.ts'
import { dev, RESTART_CODE } from './dev.ts'
import { regionProbe, verifyRegions } from '@weft/plan'
import { decide, formatProfile, readProfile } from './profile.ts'
import { createApp, serveApp } from './serve.ts'
import { DEVTOOLS_PATH } from './devtools.ts'
import { scaffold, type Template } from './scaffold.ts'

const HELP = `weft — a folder is an application

  weft dev [dir]          serve it, and rebuild what changes
  weft build [dir]        sealed templates, the generated plan, the intent manifest, revved assets
  weft start [dir]        serve the build. No compiler runs
  weft create <name>      a new application, with a page you can open
  weft routes [dir]       the route table, as the file tree produced it
  weft why <route> [dir]  what the generated plan says about a route, and where each fact came from
  weft profile [dir]      what a recording decided about delivery, and what it refuses to decide
  weft verify [dir]       what this deployment's registry says about every region a route composes

Options
  --port <n>              default 3000, or PORT
  --host <name>           default localhost
  --devtools              dev only: this application's routes, effect sets, keys and bytes
  --profile               record what every render costs, and plan the next build from it
  --probe                 verify only: ask each remote region what it is serving right now
  --template <name>       create only: minimal | app   (default app)
  --no-types              skip the type checker. Escape elision falls back to escaping
`

interface Argv {
  command: string
  positional: string[]
  flags: Record<string, string | boolean>
}

function parseArgv(argv: readonly string[]): Argv {
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const name = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) flags[name] = true
    else {
      flags[name] = next
      i++
    }
  }
  return { command: positional.shift() ?? '', positional, flags }
}

function overridesFrom(flags: Argv['flags']): {
  port?: number
  host?: string
  types?: boolean
  devtools?: boolean
  profile?: boolean
} {
  const port = flags.port ?? process.env.PORT
  return {
    ...(port ? { port: Number(port) } : {}),
    ...(typeof flags.host === 'string' ? { host: flags.host } : {}),
    ...(flags.types === false || flags['no-types'] ? { types: false } : {}),
    // Only when asked. A flag on the command line is the right place for something that must
    // never be deployed, and a config that carries it is a config `weft start` has to refuse.
    ...(flags.devtools === true ? { devtools: true } : {}),
    // Recording is a deployment's decision either way, so unlike devtools this is allowed in a
    // config as well as on the command line — a profile worth having comes from real traffic.
    ...(flags.profile === true ? { profile: true } : {}),
  }
}

function out(text: string): void {
  process.stdout.write(text)
}

async function main(): Promise<number> {
  const { command, positional, flags } = parseArgv(process.argv.slice(2))
  if (!command || flags.help || command === 'help') {
    out(HELP)
    return command ? 0 : 2
  }
  const root = resolve(positional[0] ?? '.')
  const overrides = overridesFrom(flags)

  if (command === 'create') {
    const target = positional[0]
    if (!target) {
      process.stderr.write('weft create <name>\n')
      return 2
    }
    const directory = resolve(target)
    const created = await scaffold({
      directory,
      // The package name is the folder's, not the path the user typed: `weft create ../apps/shop`
      // is an application called shop.
      name: basename(directory),
      template: (typeof flags.template === 'string' ? flags.template : 'app') as Template,
    })
    out(created.message)
    return 0
  }

  if (command === 'dev') {
    // The supervisor. A `.tsx` or `.css` change is rebuilt in place; a `.ts` change cannot be,
    // because an imported module cannot be un-imported — so the child asks to be replaced.
    if (!process.env.WEFT_DEV_CHILD) return supervise()
    const server = await dev(root, overrides, ({ file, ms, kind, error }) => {
      if (error) out(`\n  ${file} — ${error.message}\n\n`)
      else if (kind === 'restart') out(`  ${file} — restarting\n`)
      else out(`  ${file} — rebuilt in ${ms} ms\n`)
    })
    const listed = await routeList(root, overrides)
    out(
      banner(
        'dev',
        server.url,
        listed.patterns,
        listed.devtools ? DEVTOOLS_PATH : undefined,
        server.warnings,
      ),
    )
    hold(() => server.close())
    return 0
  }

  if (command === 'build') {
    out(formatReport(await build(root, overrides)))
    return 0
  }

  if (command === 'start') {
    const config = await loadConfig(root, overrides)
    const discovered = await discover(root, config.srcDir)
    const compiled = await loadBuild(discovered, config)
    const serving = await serveApp(await createApp(root, { ...overrides, mode: 'start', compiled }))
    out(
      banner(
        'start',
        serving.url,
        serving.app.routes.map((r) => r.pattern),
      ),
    )
    hold(() => serving.close())
    return 0
  }

  if (command === 'routes') {
    const app = await createApp(root, { ...overrides, mode: 'dev' })
    for (const route of app.routes) {
      const live = Object.keys(route.live)
      out(
        `  ${route.pattern.padEnd(26)} ${route.plan.slots.map((s) => s.name).join(', ')}` +
          `${live.length ? `  (live: ${live.join(', ')})` : ''}\n`,
      )
    }
    return 0
  }

  if (command === 'why') {
    const pattern = positional[0]
    if (!pattern) {
      process.stderr.write('weft why <route>\n')
      return 2
    }
    const app = await createApp(root, { ...overrides, mode: 'dev' })
    const route = app.routes.find((r) => r.pattern === pattern)
    if (!route) {
      process.stderr.write(`no route ${pattern}. Known: ${app.routes.map((r) => r.pattern).join(', ')}\n`)
      return 1
    }
    out(`${JSON.stringify(route.plan, null, 2)}\n`)
    return 0
  }

  if (command === 'profile') {
    const config = await loadConfig(root, overrides)
    const profile = await readProfile(root, config.outDir)
    if (!profile) {
      process.stderr.write(
        `no recording in ${config.outDir}/profile.json. Serve with \`profile: true\` in the config or ` +
          `\`weft dev --profile\`, take some traffic, and ask again — a plan generated from two requests ` +
          `is a plan generated from a guess with extra steps.\n`,
      )
      return 1
    }
    const decisions = decide(profile)
    out(formatProfile(profile, decisions))
    // What it *would* change, against what the convention says today, so the diff is the point
    // rather than the numbers.
    const app = await createApp(root, { ...overrides, mode: 'dev' })
    const changes: string[] = []
    for (const route of decisions.routes) {
      const plan = app.routes.find((r) => r.pattern === route.route)?.plan
      if (!plan) continue
      for (const decision of route.slots) {
        const spec = plan.slots.find((slot) => slot.name === decision.slot)
        if (!spec || decision.delivery === null) continue
        if (spec.delivery !== decision.delivery) {
          changes.push(`  ${route.route} ${decision.slot}: ${spec.delivery} -> ${decision.delivery}`)
        }
      }
    }
    out(changes.length ? `  what this changes\n${changes.join('\n')}\n\n` : '  the plan already agrees\n\n')
    return 0
  }

  if (command === 'verify') {
    /**
     * The four facts in four places, compared where the answers are.
     *
     * A route says a region is remote. The config says where it is. This deployment says which
     * executors it binds. The region itself says what it is serving. Every pair of those can
     * disagree, and none of the disagreements is knowable at build time — a registry can be written
     * to without anybody rebuilding, which is the whole reason it is a port.
     *
     * `--probe` is the one that needs the network, and it is the window CI cannot close: a contract
     * test against a published type says what was true when the type was published, and this says
     * what is true at the moment of the deploy. Without it the command is still worth running,
     * because three of the four comparisons need nothing but this process.
     */
    const app = await createApp(root, { ...overrides, mode: 'dev' })
    const composing = app.routes.map((route) => route.plan).filter((p) => p.slots.some((s) => s.region))
    if (!composing.length) {
      out('\n  no route composes a region, so there is nothing here to disagree\n\n')
      return 0
    }
    const report = await verifyRegions(
      composing,
      {
        ...(app.ports.registry ? { registry: app.ports.registry } : {}),
        executors: Object.keys(app.config.executors),
      },
      flags.probe === true ? regionProbe(app.ports) : undefined,
    )
    out(`\n  route              region          locus   where               serving\n${report.text}`)
    if (!report.errors.length) {
      out(
        `  ${report.regions.length} region(s) agree` +
          `${flags.probe === true ? ', including what each one says it is serving right now' : ', and nothing was asked what it is serving — add --probe'}\n\n`,
      )
      return 0
    }
    // A non-zero exit is the whole point of this being a command rather than a function: a deploy
    // step that cannot fail is a deploy step nobody reads the output of.
    process.stderr.write(
      `\n  ${report.errors.length} disagreement(s). A plan declared remote is a plan whose hop count, ` +
        `cache class and render location were all decided on that basis\n\n`,
    )
    return 1
  }

  process.stderr.write(`unknown command: ${command}\n\n${HELP}`)
  return 2
}

async function routeList(
  root: string,
  overrides: Record<string, unknown>,
): Promise<{ patterns: string[]; devtools: boolean }> {
  const config = await loadConfig(root, overrides)
  const discovered = await discover(root, config.srcDir)
  return { patterns: discovered.routes.map((route) => route.pattern), devtools: config.devtools }
}

function banner(
  command: string,
  url: string,
  patterns: readonly string[],
  devtools?: string,
  warnings: readonly string[] = [],
): string {
  const lines = ['', `  weft ${command} · ${url}`, '']
  for (const pattern of patterns) lines.push(`  ${pattern}`)
  // Printed rather than left to be discovered: a page nobody can find is a page nobody has.
  if (devtools) lines.push('', `  devtools · ${new URL(devtools, url).href}`)
  // Same argument, one step stronger: a gate that will refuse every call it is asked about should
  // say so before the first call rather than as a 501 in front of somebody.
  for (const warning of warnings) lines.push('', `  ${warning}`)
  lines.push('')
  return lines.join('\n')
}

/**
 * Runs `weft dev` in a child and starts it again whenever it asks.
 *
 * It exists for one reason: an edited `.ts` is only picked up by a new module graph, and a new
 * module graph means a new process. Everything else reloads in place, so this is the rare path —
 * and it is a supervisor rather than `node --watch` so that the common path can stay in place.
 */
function supervise(): Promise<number> {
  return new Promise((resolve_) => {
    let stopping = false
    const start = (): void => {
      const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
        stdio: 'inherit',
        env: { ...process.env, WEFT_DEV_CHILD: '1' },
      })
      child.on('exit', (code, signal) => {
        if (stopping || signal) {
          resolve_(0)
          return
        }
        if (code === RESTART_CODE) {
          start()
          return
        }
        resolve_(code ?? 0)
      })
      const stop = (): void => {
        stopping = true
        child.kill('SIGTERM')
      }
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
    }
    start()
  })
}

function hold(close: () => Promise<void>): void {
  const stop = (): void => {
    void close().then(() => process.exit(0))
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

main().then(
  (code) => {
    if (code !== 0) process.exit(code)
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    // A framework error names its own code; anything else gets a stack, because an unnamed
    // failure with no stack is the one thing a user cannot act on.
    process.stderr.write(/^E_[A-Z_]+/.test(message) ? `\n  ${message}\n\n` : `${(error as Error).stack}\n`)
    process.exit(1)
  },
)
