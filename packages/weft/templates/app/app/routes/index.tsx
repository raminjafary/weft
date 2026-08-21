import { fragment } from 'weft'

interface Step {
  n: string
  what: string
  where: string
}

interface Props {
  name: string
  logo: string
  steps: Step[]
}

/**
 * The page you are looking at. It is one file, and this is all of it.
 *
 * There is no component tree here and nothing mounts in the browser: the compiler sealed this
 * into a template at build time, the server filled its holes, and the only JavaScript the page
 * loaded is the framework's own client — which on a page with no signals and no intents does
 * nothing at all. Delete `index.data.ts` and the page still renders; it just has no values.
 */
export default fragment(({ name, logo, steps }: Props) => (
  <>
    <section class="weft-hero hero">
      <img class="hero-mark" src={logo} alt="" width="44" height="44" />
      <span class="weft-eyebrow">weft</span>
      <h1>{name} is running.</h1>
      <p class="weft-lede">
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

    <div class="weft-grid">
      <div class="weft-card">
        <h3>Nothing mounted</h3>
        <p>
          This page shipped no component code. Adoption binds nodes to values by walking marker comments, so
          what the browser pays for is the number of live bindings on the page — and this page has none.
        </p>
      </div>
      <div class="weft-card">
        <h3>One sealed template</h3>
        <p>
          Rendering the same component ten times adds ten items of content and no template. Page weight tracks
          what is on the page, not how many components drew it.
        </p>
      </div>
      <div class="weft-card">
        <h3>No CSS to write</h3>
        <p>
          The framework ships a stylesheet. Put a <code>.css</code> beside any fragment and only the pages
          that render it will link it.
        </p>
      </div>
    </div>

    <h2>Next</h2>
    <ol class="weft-next">
      {steps.map((step) => (
        <li>
          <span class="weft-step">{step.n}</span>
          <div>
            <p>{step.what}</p>
            <code>{step.where}</code>
          </div>
        </li>
      ))}
    </ol>
  </>
))
