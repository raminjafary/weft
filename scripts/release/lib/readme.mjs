import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { README_MARKERS } from '../config.mjs'
import { fail } from './shell.mjs'
import { ROOT } from './workspace.mjs'

/**
 * What each package is. The release script owns the version column and nothing else, so this is the
 * one place a new package has to be described — the table is otherwise generated.
 */
const DESCRIPTIONS = {
  '@weft/core': 'The framework. The CLI, the conventions, and what an application imports',
  'create-weft': '`npm create weft` — a shim over the templates that ship inside `@weft/core`',
  '@weft/ir': 'The template IR: what a compiled fragment is',
  '@weft/warp': 'The frame vocabulary that carries it',
  '@weft/compiler': 'TSX to IR, on Oxc, with the type-driven escape class',
  '@weft/kernel': 'Routing, the request lifecycle, cache keys, waves, epochs, surgical refresh',
  '@weft/client': 'Adoption, signals, deltas, patches, navigation',
  '@weft/plan': 'The plan DSL, validation against inferred effects, plugins, `weft why`',
  '@weft/adapters': 'The fourteen ports, implemented',
  '@weft/bench': 'The measurement harness, and the gates it enforces',
  '@weft/docs': 'The documentation site, which is a weft application',
  '@weft/inspector': 'A station per capability, each with a control you can turn',
}

/** Published packages first, in install order rather than alphabetical: what you install, then what it pulls in. */
const ORDER = [
  '@weft/core',
  'create-weft',
  '@weft/ir',
  '@weft/warp',
  '@weft/compiler',
  '@weft/client',
  '@weft/kernel',
  '@weft/plan',
  '@weft/adapters',
  '@weft/bench',
  '@weft/docs',
  '@weft/inspector',
]

export function renderVersionTable(packages, versions) {
  const rows = []
  const missing = [...packages.keys()].filter((name) => !ORDER.includes(name))
  if (missing.length) fail(`scripts/release/lib/readme.mjs does not know about ${missing.join(', ')}`)

  for (const name of ORDER) {
    const pkg = packages.get(name)
    if (!pkg) continue
    const version = versions.get(name) ?? pkg.version
    // The literal version on the registry, not a badge: this table is what the last release
    // published, and a badge would keep reading as current after a publish that failed halfway.
    const cell = pkg.isPrivate ? '_not published_' : `[\`${version}\`](https://www.npmjs.com/package/${name})`
    rows.push([`\`${name}\``, cell, DESCRIPTIONS[name] ?? pkg.manifest.description ?? ''])
  }

  const header = ['Package', 'Version', 'What it is']
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column].length)),
  )
  const line = (cells) => `| ${cells.map((cell, column) => cell.padEnd(widths[column])).join(' | ')} |`

  return [
    line(header),
    `| ${widths.map((width) => '-'.repeat(width)).join(' | ')} |`,
    ...rows.map(line),
  ].join('\n')
}

/**
 * Replace the table between the markers.
 *
 * The markers have to already be there. Guessing where a table belongs in a README is how a release
 * script ends up rewriting prose, so a missing marker is a failure with an instruction rather than a
 * best effort.
 */
export function writeVersionTable(table) {
  const path = join(ROOT, 'README.md')
  const contents = readFileSync(path, 'utf8')
  const start = contents.indexOf(README_MARKERS.start)
  const end = contents.indexOf(README_MARKERS.end)
  if (start === -1 || end === -1 || end < start) {
    fail(
      `README.md needs the markers ${README_MARKERS.start} and ${README_MARKERS.end} around the package table.`,
    )
  }
  const updated =
    contents.slice(0, start + README_MARKERS.start.length) + `\n\n${table}\n\n` + contents.slice(end)
  if (updated === contents) return { path, changed: false }
  writeFileSync(path, updated)
  return { path, changed: true }
}
