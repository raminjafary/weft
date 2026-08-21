# The demo

Every capability this framework has, running, with a control that lets you feel the mechanism
rather than read about it.

```
npm run demo          # http://localhost:4173
npm run demo:dev      # the same, restarted on change
PORT=5000 npm run demo
```

## What is here

**Five showcases** — whole pages, each leaning on several capabilities at once, because a
framework can win every isolated station and still be miserable to build a page with.

| Page                   | Stands for                                                          |
| ---------------------- | ------------------------------------------------------------------- |
| `/app/ordinary/pantry` | Most pages. Components, props, no streaming, no channel, no deltas  |
| `/app/feed`            | Hundreds of rows, shared cache, deltas over a live channel          |
| `/app/cart`            | A signed-in region inside a shared shell, and intents that write it |
| `/app/article`         | The case where almost nothing should ship                           |
| `/app/dashboard`       | Four independent queries of very different cost                     |

**Thirty-three stations** — one per mechanism, at `/s/<id>`. `/` lists them and `/spec` is the
coverage table.

## Three rules this directory keeps

**Every page is served by the framework.** The index, the coverage page and every station go
through `kernel.serve`, not only the showcases. A demo whose own chrome is rendered by something
else has quietly exempted itself from its own claims.

**Every number comes from `@weft/bench`.** A demo with its own measurement path is a demo that
will disagree with the harness, and the disagreement will be found by somebody who trusted the
demo. Each station prints what produced its number and what the number does not cover.

**Not a subset.** If a capability is in the specs it has a station, and
[`test/stations.test.ts`](test/stations.test.ts) fails the build when a spec document has no
station pointing at it. The same test refuses to let a station claim `live` without a handler
registered, so the index cannot advertise a page that does not run. A station for something that
does not exist says so and links to the roadmap — better an honest empty station than a mock.

## No build step

Client modules are TypeScript served with their types stripped by Node, so what runs in the
browser is the file in the repository. Fragments are compiled by the real compiler at boot, so a
station showing you an inferred read set is showing you what the compiler inferred from the file
open next to it.

## Where things are

```
src/fragments/*.tsx   the pages and components, compiled by @weft/compiler
src/showcases.ts      the five showcases, authored through the plan DSL
src/stations/*.ts     one handler per station
src/channel.ts        the Warp hub and the intents the cart dispatches
src/race.ts           the live streaming race the streaming-order station frames
src/client/boot.ts    the browser half: adoption, controls, the channel
src/server.ts         the wiring — and the honest measure of how much of it there is
```

`src/server.ts` being two hundred lines of wiring is itself a finding. It is the only worked
example of standing this framework up, and hiding it behind a CLI is the first item on
[`ROADMAP.md`](../ROADMAP.md).
