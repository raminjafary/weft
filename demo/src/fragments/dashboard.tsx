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
  series: Series[]
}

/**
 * One dashboard panel. Every panel on the page is its own slot with its own latency, its own
 * cache policy and its own executor, which is the point: the expensive one is not shared, the
 * cheap ones are, and the wave scheduler runs them by data dependency rather than by the order
 * somebody wrote them in.
 */
export default fragment(({ name, costMs, executor, cacheClass, series }: PanelProps) => (
  <div class="dash-panel" data-executor={executor} data-class={cacheClass}>
    <h3>{name}</h3>
    <p class="cost">
      {costMs} ms · {executor} · {cacheClass}
    </p>
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
