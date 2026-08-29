import { fragment } from '@weftjs/core'

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

/** One dashboard panel: its own slot, latency, cache policy and executor. `style={barStyle}` is the case a stylesheet can't cover — the length is data. */
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
