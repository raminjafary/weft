import { fragment } from 'weft'

interface Step {
  n: string
  what: string
  where: string
}

interface Props {
  name: string
  steps: Step[]
}

/**
 * The page you are looking at. It is one file, and this is all of it.
 *
 * There is no component tree here and nothing mounts in the browser: the compiler sealed this
 * into a template at build time, the server filled its holes, and the only JavaScript the page
 * loaded is the framework's own client — which on a page with no signals and no intents does
 * nothing at all. Delete `index.data.ts` and the page still renders; it just has no values.
 *
 * Deliberately short. A welcome page whose job is to be deleted should be small enough to read in
 * full before deleting it, and every line here is either the framework's own stylesheet doing the
 * work or a file name you are about to open.
 */
export default fragment(({ name, steps }: Props) => (
  <>
    <section class="hero">
      <svg class="mark" width="48" height="48" viewBox="0 0 24 24" aria-hidden="true">
        <g class="warp">
          <rect x="4.6" y="2" width="2" height="20" rx="1" />
          <rect x="11" y="2" width="2" height="20" rx="1" />
          <rect x="17.4" y="2" width="2" height="20" rx="1" />
        </g>
        <g class="weft">
          <rect x="1" y="7" width="22" height="2" rx="1" />
          <rect x="1" y="15" width="3.6" height="2" rx="1" />
          <rect x="6.6" y="15" width="4.4" height="2" rx="1" />
          <rect x="13" y="15" width="4.4" height="2" rx="1" />
          <rect x="19.4" y="15" width="3.6" height="2" rx="1" />
        </g>
      </svg>
      <h1>{name} is running.</h1>
      <p>
        A folder is an application. The route table above is <code>app/routes</code>, the document is{' '}
        <code>app/layout.tsx</code>, and the plan that placed everything on this page was generated from those
        two facts rather than written by hand.
      </p>
      <div class="weft-row">
        <a class="weft-button" data-variant="primary" href="/counter">
          A page that writes something
        </a>
        <a class="weft-button" href="/guide/routing">
          How routing works
        </a>
      </div>
    </section>

    <ol class="next">
      {steps.map((step) => (
        <li>
          <span class="n">{step.n}</span>
          <p>{step.what}</p>
          <code>{step.where}</code>
        </li>
      ))}
    </ol>
  </>
))
