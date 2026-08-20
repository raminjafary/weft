import { fragment, raw } from 'weft'

export default fragment(({ title, cssVersion, runtimeVersion, flags, cartCount, cartLines, recs, footer }) => (
  <>
    {raw('<!doctype html>')}
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>{title}</title>
        <link rel="stylesheet" href={cssVersion} />
        <script type="module" src={runtimeVersion} />
      </head>
      <body data-flags={flags}>
        <header class="top">
          <a href="/" class="brand">Souq</a>
          <nav>
            <a href="/orders">Orders</a>
            <a href="/cart">Cart ({cartCount})</a>
          </nav>
        </header>
        <main>
          <section id="cart-lines">
            <template shadowrootmode="open">
              <slot name="cart-lines">{cartLines}</slot>
            </template>
          </section>
          <section id="recommendations">
            <template shadowrootmode="open">
              <slot name="recs">{recs}</slot>
            </template>
          </section>
        </main>
        <footer>{footer}</footer>
      </body>
    </html>
  </>
))
