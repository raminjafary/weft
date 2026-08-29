import { fragment } from '@weftjs/core'

export interface MarkProps {
  /** Rendered size in CSS pixels. The geometry is a 24-unit grid, so any size holds. */
  size: string
  /** `mark`, `mark quiet`, `mark invert` — the whole class, so the tone is a value not a branch. */
  cls: string
}

/**
 * The mark: a weft crossing a warp. Six rectangles on a 24-unit grid — the favicon at 16px and the
 * wordmark's companion at 76 are the same geometry. Colours are custom properties, not
 * `currentColor`: the mark is deliberately two-tone.
 */
export default fragment(({ size, cls }: MarkProps) => (
  <svg class={cls} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <g class="mark-warp">
      <rect x="4.6" y="2" width="2" height="20" rx="1" />
      <rect x="11" y="2" width="2" height="20" rx="1" />
      <rect x="17.4" y="2" width="2" height="20" rx="1" />
    </g>
    <g class="mark-weft">
      <rect x="1" y="7" width="22" height="2" rx="1" />
      <rect x="1" y="15" width="3.6" height="2" rx="1" />
      <rect x="6.6" y="15" width="4.4" height="2" rx="1" />
      <rect x="13" y="15" width="4.4" height="2" rx="1" />
      <rect x="19.4" y="15" width="3.6" height="2" rx="1" />
    </g>
  </svg>
))
