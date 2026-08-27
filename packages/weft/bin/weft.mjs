#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The `weft` command, as a file that always exists.
 *
 * A package manager links a bin when it installs, and `dist/` is written by a build that runs
 * afterwards — so a bin pointing straight at `dist/cli.js` is one no fresh clone and no CI checkout
 * ever gets. The symptom is `weft: command not found` in the line right after a build that
 * succeeded, which names neither the cause nor the fix.
 *
 * So the link points here instead, and here decides. The built entry when there is one, the source
 * otherwise — the same order `packageTree` uses for a package's servable modules, and for the same
 * reason: a repository that has not been built yet should still be able to run its own tools.
 */
const dist = new URL('../dist/cli.js', import.meta.url)
await import(existsSync(fileURLToPath(dist)) ? dist.href : new URL('../src/cli.ts', import.meta.url).href)
