# @weft/warp

Warp/1 — the binary frame codec the channel speaks.

Part of [weft](https://github.com/raminjafary/weft), a TypeScript fullstack framework that
negotiates the wire form of a piece of UI per request. Applications import `weft`; this package is
the envelope everything else travels in.

```sh
npm install @weft/warp
```

## What it is

Every render in the framework produces Warp frames — a document, a surgical delta, a patch, a
template a client does not yet hold, a region composed from another pod. Because that is true at
every tier, there is no translation layer at a boundary: a region running in another process
returns the same frames as one running here, and the two produce byte-identical markup.

Frames say who they are. A region opens with `REGION` naming **itself** and may write only into its
own hole; a sibling's slot is `E_REGION_ESCAPE`, and a `SHELL`, `COOKIE` or `PLAN` from a region is
`E_REGION_FRAME` with the authority it would have borrowed named.

## Version

Warp is a versioned specification —
[`spec/warp/warp-1.md`](https://github.com/raminjafary/weft/blob/main/spec/warp/warp-1.md), with the
majors-refuse rule in
[`spec/VERSIONING.md`](https://github.com/raminjafary/weft/blob/main/spec/VERSIONING.md).

## License

MIT
