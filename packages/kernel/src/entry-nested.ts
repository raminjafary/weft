/**
 * The document request path, plus a document made of nested layouts. Its own entry: a
 * deployment whose layouts are flat should not import the chain splice. See `spec/kernel/budgets.md`.
 */
export * from './entry-request.ts'
export { chainSplitter, type ShellLink } from './split-chain.ts'
