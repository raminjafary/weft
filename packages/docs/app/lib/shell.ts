import { artifacts } from './versions.ts'

/**
 * The layout values every page supplies, in one place.
 *
 * The framework fills the standard holes — title, description, css, runtime, nav, prelude — and a
 * route fills the rest. Three of the rest are the same on every page of this site: the version
 * pill, the repository link and the boot script. Writing them at eleven call sites would be eleven
 * chances for one page to carry a version the others do not, so they are written here and every
 * route spreads this.
 */

/** `ir 2.6.0 · warp 1.8.0` — the two numbers a build stamps on a document, not two numbers typed. */
export function versionPill(): string {
  const by = new Map(artifacts().map((artifact) => [artifact.what, artifact.version]))
  return `ir ${by.get('Template IR')} · warp ${by.get('Warp frames')}`
}

export const REPO = 'https://github.com/raminjafary/weft'

/**
 * The one script that runs before paint, and the whole of what it does.
 *
 * Two jobs, both of which have to happen before the first frame or they are visible as a flash:
 * apply a theme the reader chose on a previous visit, and record that scripting is on. The second
 * is what lets the stylesheet hide the theme toggle from a reader who cannot use it, rather than
 * offering a control that does nothing.
 *
 * It is inline and it is under 200 bytes. A deferred module would run after paint, which for a
 * theme is the same as not running at all.
 */
export const BOOT =
  `<script>(()=>{try{const r=document.documentElement;r.dataset.js='on';` +
  `const t=localStorage.getItem('weft-theme');if(t==='light'||t==='dark')r.dataset.theme=t}catch{}})()</script>`

export interface ShellInput {
  /** The page's `<h1>`. Section layouts render it; the landing page renders its own. */
  heading: string
  lede: string
  /**
   * The line above the heading. `kicker` is the accent text or the word on the chip, `kickerClass`
   * decides which of the two it is, and `kickerNote` is the dim half beside it.
   */
  kicker?: string
  kickerClass?: 'kicker' | 'badge'
  kickerNote?: string
  /** The middle crumb — the group a guide page is in. Empty draws no trail. */
  section?: string
}

/**
 * What a route hands the layout chain. Spread it, then add whatever that page alone needs.
 *
 * An empty `section` or `kicker` is what a layout's own conditional branches on, rather than a
 * class name decided here: a layout may carry a derived expression, and the branch belongs beside
 * the markup it turns on and off. It briefly could not — see the note in `splitAtSlots` for what
 * that cost and why it is fixed rather than worked around.
 */
export function shell(input: ShellInput): Record<string, unknown> {
  return {
    heading: input.heading,
    lede: input.lede,
    section: input.section ?? '',
    kickerClass: input.kickerClass ?? 'kicker',
    kicker: input.kicker ?? '',
    kickerNote: input.kickerNote ?? '',
    versions: versionPill(),
    repo: REPO,
    boot: BOOT,
  }
}

/** The sections whose content is walked out of the source rather than written by hand. */
export const GENERATED = { kicker: 'generated', kickerClass: 'badge' } as const
