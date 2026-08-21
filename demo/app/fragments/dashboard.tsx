import { fragment } from 'weft'

interface Series {
  label: string
  value: string
  trend: string
}

interface PanelProps {
  name: string
  costMs: number
  executor: string
  cacheClass: string
  /** `--bar: 42%` — a computed length, which is exactly what an inline style is for. */
  barStyle: string
  series: Series[]
}

/**
 * One dashboard panel. Every panel on the page is its own slot with its own latency, its own
 * cache policy and its own executor, which is the point: the expensive one is not shared, the
 * cheap ones are, and the wave scheduler runs them by data dependency rather than by the order
 * somebody wrote them in.
 *
 * `style={barStyle}` is the case a stylesheet cannot cover: the bar's length is data, and a rule
 * cannot know it. It lowers to an ordinary attribute hole — escaped, because the compiler cannot
 * prove a string is safe — so a computed style costs one hole and no client code. A static rule
 * belongs in `dashboard.css` beside this file; a value belongs here.
 */
export default fragment(({ name, costMs, executor, cacheClass, barStyle, series }: PanelProps) => (
  <div class="dash-panel" data-executor={executor} data-class={cacheClass}>
    <h3>{name}</h3>
    <p class="cost">
      {costMs} ms · {executor} · {cacheClass}
    </p>
    <div class="dash-bar" style={barStyle} />
    <ul>
      {series.map((point) => (
        <li data-trend={point.trend}>
          <span class="label">{point.label}</span>
          <span class="value">{point.value}</span>
        </li>
      ))}
    </ul>
  </div>
))
