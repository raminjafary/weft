import { fragment, raw } from 'weft'

interface NavItem {
  href: string
  label: string
  current: string
}

interface DashProps {
  title: string
  css: string
  runtime: string
  nav: NavItem[]
  panel: string
  traffic: string
  revenue: string
  errors: string
  slowest: string
  readout: string
}

/**
 * A second shell, because a page with a different slot shape is a different shell.
 *
 * That is not a workaround: slots inside components are `E_COMPONENT_CHILDREN_UNSUPPORTED`, so a
 * template cannot delegate its own boundaries to a child. The cost is this file's chrome
 * duplicating the other shell's; the benefit is that each of these five holes is a real cut point
 * the kernel can stream independently, with its own cache policy, executor and budget.
 */
export default fragment(
  ({ title, css, runtime, nav, panel, traffic, revenue, errors, slowest, readout }: DashProps) => (
    <>
      {raw('<!doctype html>')}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width,initial-scale=1" />
          <title>{title}</title>
          <link rel="stylesheet" href={css} />
          <script type="module" src={runtime} />
        </head>
        <body data-station="dashboard">
          <header class="top">
            <a class="brand" href="/">
              weft
            </a>
            <nav>
              {nav.map((item) => (
                <a href={item.href} data-current={item.current}>
                  {item.label}
                </a>
              ))}
            </nav>
          </header>
          <main>
            <h1>A dashboard with slow panels</h1>
            <p class="shows">
              Four independent queries of very different cost. Each panel is its own slot, with its own
              latency, its own cache policy and its own executor.
            </p>
            <section class="panel">
              <slot name="panel">{panel}</slot>
            </section>
            <section class="grid">
              <slot name="traffic">{traffic}</slot>
              <slot name="revenue">{revenue}</slot>
              <slot name="errors">{errors}</slot>
              <slot name="slowest">{slowest}</slot>
            </section>
            <section class="readout">
              <slot name="readout">{readout}</slot>
            </section>
          </main>
        </body>
      </html>
    </>
  ),
)
