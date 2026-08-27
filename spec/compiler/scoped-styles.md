# Scoped stylesheets

A component's stylesheet should be the component's. A global one is not: two components that both
call something `.head` collide, and the collision surfaces on whichever page happens to render both
— which is a page neither author was looking at.

`app/fragments/card.scoped.css` is scoped to `app/fragments/card.tsx`. Every element that template
declares carries an attribute, and every selector in that sheet is narrowed to it. The class in the
sheet is the class in the markup; only the reach changes.

## What it costs

Nothing at runtime, and one attribute per element on the wire.

A template here is data, not a function, so the attribute is written into the sealed bytes by the
compiler at build time. There is no hydration step, no style element injected, and no class-name
mangling to read past in a stack trace or a devtools panel. This is the same mechanism Vue, Svelte
and Angular use; what is different is when it happens.

```
<div data-w-d901a5ad class="card">
  <h3 data-w-d901a5ad class="title">…</h3>
</div>
```

```css
/* app/fragments/card.scoped.css, as authored */
.card {
  border: 1px solid red;
}
.card .body {
  opacity: 0.7;
}
```

```css
/* as served */
.card[data-w-d901a5ad] {
  border: 1px solid red;
}
.card .body[data-w-d901a5ad] {
  opacity: 0.7;
}
```

## Opting in

By filename, and by nothing else.

| File              | Reach                                          |
| ----------------- | ---------------------------------------------- |
| `card.css`        | Global, linked by the pages that render `card` |
| `card.scoped.css` | Narrowed to the elements `card.tsx` declares   |

Both may sit beside one fragment, and they cascade in that order — global first, scoped after — so a
component can take the shared look and then say what is different about it.

The filename carries the decision because the decision has to be visible. A marker inside the file
would put it where a reader of the diff does not look, and a config list would put it in a third
place that can disagree with both. Renaming the file is the whole of the change.

It works for every kind of template the convention knows: `app/layout.scoped.css`,
`app/routes/<dir>/layout.scoped.css`, `app/routes/about.scoped.css`, `app/slots/<name>.scoped.css`,
`app/layouts/<name>.scoped.css` and `app/fragments/<name>.scoped.css`.

## The attribute

`data-w-` and eight hex characters of a hash of the file's project-relative stem.

**Derived from the path, not the contents.** Editing the template or the sheet must not change the
attribute, or every scoped page's bundle would churn on every edit and no cached stylesheet would
survive a typo fix. Two files with the same stem — `card.tsx` and `card.scoped.css` — derive the
same attribute independently, which is why nothing has to carry a pairing between them: the compiler
computes it from the template's path and the asset build computes it from the sheet's.

## Where the scope stops

**At a component boundary.** A `<Card/>` rendered inside another fragment is its own sealed template
and carries its own scope. The parent's rules do not reach into it, and there is no `:deep()`.

That is a decision rather than a gap. A parent that could style a child's internals would make the
child's markup part of the parent's contract — the child could not change shape without breaking a
caller it cannot see, and the coupling would be invisible from the child's own file. The same
argument the design already makes about templates one level up applies here: a component is sealed,
and what it renders is not the caller's business.

When a parent genuinely needs to influence a child, the child takes a prop and decides for itself.
When a rule is genuinely shared, it belongs in `app/styles.css` or in a global `.css` beside the
component.

## The transform

The attribute joins the **last compound selector**, before any pseudo.

| Authored              | Served                          | Why                                                           |
| --------------------- | ------------------------------- | ------------------------------------------------------------- |
| `.row .cell`          | `.row .cell[data-w-x]`          | The ancestor may be anywhere; the subject may not             |
| `.card:hover`         | `.card[data-w-x]:hover`         | An attribute is part of a compound; a pseudo-class filters it |
| `.card::after`        | `.card[data-w-x]::after`        | Same, and the pseudo-element must stay last                   |
| `.a, .b`              | `.a[data-w-x], .b[data-w-x]`    | Every selector in a list is a selector                        |
| `:is(.a, .b) .c`      | `:is(.a, .b) .c[data-w-x]`      | A comma inside a function is not a list separator             |
| `a[href^='/x'] .deep` | `a[href^='/x'] .deep[data-w-x]` | An authored attribute selector is not the scope               |

At-rules split into the ones that contain selectors and the ones that do not. `@media`, `@supports`,
`@container`, `@layer` and `@scope` recurse. `@keyframes` does not — its percentages look exactly
like selectors to a tokeniser, and narrowing one produces `0%[data-w-x]`, which parses, never
matches, and silently kills the animation. `@import` and `@charset` end at their semicolon and
travel as written.

The implementation is a tokeniser rather than a CSS parser, deliberately. A parser would have to
keep up with every at-rule CSS grows; the only thing this has to be right about is where a selector
list ends, so it tracks strings, comments, brackets and brace depth and nothing else. A sheet comes
back with its own formatting — a stylesheet that returned reflowed would be a diff nobody asked for.

## What this does not do

- **No `:deep()`, and no child-root stamping.** See above: this is the boundary, not a missing
  feature. A parent cannot reach into a child, in either direction.
- **`@keyframes` names are not rewritten.** Two components that both define `@keyframes spin` still
  collide on the name, because the animation name is a global identifier and rewriting it would mean
  rewriting every `animation:` shorthand that could reference it — including ones assembled from a
  custom property, where the reference is not visible to a rewriter at all. Name an animation for
  the component that owns it, or put it in the global sheet where the collision is visible.
- **It does not scope a route whose body is markup rather than a template.** A declaration-only
  route has no elements to stamp, so `E_SCOPED_NO_TEMPLATE` names the file and says to make it
  global instead. Failing at discovery is the point: a scoped sheet that silently applied to nothing
  is a stylesheet that appears to work until somebody looks.
- **It does not deduplicate across pages.** The narrowing is memoised per file within one build, but
  a page still links the sheets of the components on it, bundled into that page's one stylesheet.
  That is the same trade the unscoped path already makes and for the same reason.
- **It is not an isolation boundary.** A global rule with enough specificity still reaches a scoped
  element, and it should — a design system's tokens and resets have to. Scoping narrows a
  component's own rules; it does not defend the component from yours.
