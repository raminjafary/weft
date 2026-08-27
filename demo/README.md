# demo

Six shapes of page, built with weft. It is an application, and the interesting thing about it is
what it does _not_ contain.

```
pnpm demo
```

## It imports nothing but `weft`

Not `@weftjs/kernel`, not `@weftjs/plan`, not `@weftjs/adapters`. Its `package.json` depends on `weft`
alone, so it could not reach past the front door even by accident. If a page here needs something,
that is a gap in the framework's front door rather than a reason to open a side one — and the demo
is the thing that keeps finding those gaps.

The stations that _do_ take the framework apart moved to `@weftjs/inspector`, where that is the job.

## It has no client code

There is no `app/client.ts`. Adoption, intents, the channel, control wiring and the runtime
readouts are all the framework's, reached through attributes rather than through glue:

|                               |                                                          |
| ----------------------------- | -------------------------------------------------------- |
| `data-weft-control="rows"`    | this input owns the `rows` query parameter               |
| `data-weft-apply`             | make the page agree with its controls                    |
| `data-weft-intent="cart.add"` | dispatch this intent, over the channel or as a form post |
| `data-weft-stat="writes"`     | paint the runtime's own numbers here                     |

## One directory

```
app/
  layout.tsx            the document
  layouts/dash.tsx      the dashboard's, because it has a different shape
  layouts/race.tsx      the streaming race's
  routes/**             the route table, which is this tree
  routes/docs/layout.tsx  a layout for that subtree, nested inside app/layout.tsx
  fragments/**          components, each with its own .css beside it
  intents/**            mutations. The manifest is generated from this directory
  styles.css            linked on every page after the framework's own
  lib/**               fixtures and markup helpers. The framework does not read this
weft.config.ts          what this deployment binds
```

`app/lib/` is ordinary application code — fake products, an article, the form widgets the panels
are made of. The framework only reads the directories named above it, so there is nowhere for
`lib/` to accidentally become a route.
