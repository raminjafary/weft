# @weft/adapters

The ports, implemented: Node HTTP, channels, stores, sessions, flags, leases and a worker pool.

Part of [weft](https://github.com/raminjafary/weft), a TypeScript fullstack framework that
negotiates the wire form of a piece of UI per request. Eleven of the fourteen ports are bound by the
front door with no configuration at all.

```sh
npm install @weft/adapters
```

## What it is

The kernel imports nothing but the WinterTC Minimum Common Web API, so everything platform-shaped
lives here. Fourteen ports are declared and fourteen are implemented.

**A port that is not bound refuses by name and never approximates.** A declared rate limit with no
limiter is `E_NO_RATE_LIMIT`, not unlimited. `countingLimits` is a fixed window and says so — a
sliding one needs a store that can count atomically, and `StorePort` deliberately has a lease rather
than a counter.

**A store on an edge key-value namespace refuses `lease` outright.** A lease that is not atomic is a
stampede guard that does not guard and a replay guard that reports every nonce fresh, which is the
one place in this framework where an approximation would be a security bug. `sharedLeases(store, { dir })`
agrees across every process on a machine; `redisLeases(store, { url })` across every instance of a
deployment; neither makes the cache shared.

## Reference

[`spec/kernel/ports.md`](https://github.com/raminjafary/weft/blob/main/spec/kernel/ports.md)

## License

MIT
