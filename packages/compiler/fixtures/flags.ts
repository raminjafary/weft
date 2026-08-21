/**
 * Flags are referenced rather than named, so a rename is a compile error instead of a silent
 * cache miss. The value is never read at build time — the compiler takes the identifier and
 * kebab-cases it, and `FlagPort.axes()` is what says which values are reachable.
 */
export const newCart = { key: 'new-cart' }
export const priceBanner = { key: 'price-banner' }
