import { artifacts } from './versions.ts'

/**
 * The layout values every page supplies, in one place. Three of them — version pill, repo link,
 * boot script — are the same on every page, so they're written here once rather than at eleven call
 * sites that could each carry a different version.
 */

/** `ir 2.6.0 · warp 1.8.0` — the two numbers a build stamps on a document, not two numbers typed. */
export function versionPill(): string {
  const by = new Map(artifacts().map((artifact) => [artifact.what, artifact.version]))
  return `ir ${by.get('Template IR')} · warp ${by.get('Warp frames')}`
}

export const REPO = 'https://github.com/raminjafary/weft'

/**
 * The one script that runs before paint: applies a stored theme and marks scripting on, both of
 * which would flash if they ran after paint. Inline and under 200 bytes — a deferred module runs
 * too late to matter for either.
 */
export const BOOT =
  `<script>(()=>{try{const r=document.documentElement;r.dataset.js='on';` +
  `const t=localStorage.getItem('weft-theme');if(t==='light'||t==='dark')r.dataset.theme=t}catch{}})()</script>`

export interface ShellInput {
  /** The page's `<h1>`. Section layouts render it; the landing page renders its own. */
  heading: string
  lede: string
  /** The line above the heading. `kicker` is the text, `kickerClass` decides accent-vs-chip, `kickerNote` is the dim half beside it. */
  kicker?: string
  kickerClass?: 'kicker' | 'badge'
  kickerNote?: string
  /** The middle crumb — the group a guide page is in. Empty draws no trail. */
  section?: string
  /** Which shell the section's layout draws: `shell`, `shell two`, `shell one`. A class name, since `/tutorial` and `/tutorial/:step` share one layout file. */
  shellClass?: string
}

/** What a route hands the layout chain. Spread it, then add whatever that page alone needs. An empty `section`/`kicker` is what the layout's own conditional branches on. */
export function shell(input: ShellInput): Record<string, unknown> {
  return {
    heading: input.heading,
    lede: input.lede,
    section: input.section ?? '',
    kickerClass: input.kickerClass ?? 'kicker',
    kicker: input.kicker ?? '',
    kickerNote: input.kickerNote ?? '',
    shellClass: input.shellClass ?? 'shell',
    versions: versionPill(),
    repo: REPO,
    boot: BOOT,
  }
}

/** The sections whose content is walked out of the source rather than written by hand. */
export const GENERATED = { kicker: 'generated', kickerClass: 'badge' } as const
