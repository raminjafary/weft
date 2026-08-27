# create-weft

A new [weft](https://github.com/raminjafary/weft) application, with a page you can open.

```sh
npm  create weft@latest my-app
pnpm create weft my-app
yarn create weft my-app
bun  create weft my-app
```

```sh
cd my-app
npm install
npm run dev          # http://localhost:3000
```

## Templates

|                   |                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `app` _(default)_ | A layout, three routes, a fragment with its own CSS, a slot, and a real mutation you can press |
| `minimal`         | One route, and nothing else                                                                    |

```sh
npm create weft my-app -- --template minimal
```

Already inside a project? The framework's own CLI scaffolds too: `npx weft create my-app`.

## What it writes

Every file is one the framework will actually read, and each says what it is for. The page it
produces is a real page: it renders through the kernel, its CSS is linked the way a component's CSS
is linked, and its buttons dispatch a real intent that also works with JavaScript switched off. A
scaffold whose output is a placeholder teaches nothing about the framework it is scaffolding.

A non-empty target directory is refused rather than merged — `E_NOT_EMPTY`, naming what is in the
way.

This package is a shim, deliberately. The templates and the scaffolder live in the `@weft/core` package
itself, because a scaffold that ships its own copy of them is a scaffold that will generate an
application the framework has stopped supporting.

## License

MIT
