import { fastHash, short } from '@weft/ir'

/**
 * Scoped stylesheets: `card.scoped.css` beside `card.tsx`.
 *
 * A component's stylesheet should be the component's, and a global one is not — two components that
 * both call something `.head` collide, and the collision surfaces on whichever page happens to
 * render both. Vue, Svelte and Angular all solved this the same way: stamp an attribute on the
 * elements the component declares, and narrow every selector in its sheet to that attribute.
 *
 * Here it costs less than it does there, because a template is data. The attribute is written into
 * the sealed bytes by the compiler at build time, so there is no runtime step, nothing to hydrate,
 * and no class-name mangling to read past in a stack trace — the class in the sheet is the class in
 * the markup, narrowed by an attribute.
 *
 * **Opt in by name.** `card.css` is global, as it always was. `card.scoped.css` is scoped. Both may
 * sit beside one fragment, and they cascade in that order — global first, scoped after — so a
 * component can take the shared look and then say what is different about it. Renaming the file is
 * the whole of the decision, which means the decision is visible in a diff.
 *
 * **The scope stops at a component boundary.** A `<Card/>` inside a fragment is its own sealed
 * template and carries its own scope, so a parent's rules do not reach into it. That is deliberate
 * rather than unimplemented: a parent that could style a child's internals would make the child's
 * markup part of the parent's contract, and the child could no longer change shape without breaking
 * a caller it cannot see. Style the child in the child's own sheet, or pass it a prop.
 */

/** The prefix on every scope attribute. Short, because it is written once per element. */
const PREFIX = 'data-w-'

/**
 * A stem's scope attribute, e.g. `data-w-4f3a91c2`.
 *
 * Derived from the path rather than from the contents, and that is the point: editing the template
 * or the sheet must not change the attribute, or every scoped page's bundle would churn on every
 * edit. Two files with the same stem — `card.tsx` and `card.scoped.css` — derive the same id
 * independently, which is why nothing has to carry a pairing between them.
 */
export function scopeAttribute(stem: string): string {
  return `${PREFIX}${short(fastHash(stem.split('\\').join('/')), 8)}`
}

/** `app/fragments/card.tsx` and `app/fragments/card.scoped.css` both stem to `app/fragments/card`. */
export function scopeStem(file: string): string {
  return file
    .replace(/\.scoped\.css$/, '')
    .replace(/\.data\.ts$/, '')
    .replace(/\.tsx$/, '')
    .replace(/\.css$/, '')
}

/** Is this the scoped half of a component's styling, rather than the global one? */
export function isScopedSheet(file: string): boolean {
  return file.endsWith('.scoped.css')
}

const AT_RULE_WITH_SELECTORS = /^@(media|supports|container|layer|scope)\b/i

/**
 * Narrow every selector in a stylesheet to one scope attribute.
 *
 * The transform is the one the field agreed on: the attribute joins the **last** compound selector,
 * before any pseudo-element. `.row .cell` becomes `.row .cell[data-w-x]` — the descendant may be
 * anywhere, the thing being styled may not. `.row:hover` becomes `.row[data-w-x]:hover`, because an
 * attribute is part of the compound and a pseudo-class is a filter on it.
 *
 * This is a tokeniser and not a CSS parser, and it is written that way on purpose: a parser would
 * have to keep up with every at-rule CSS grows, and the only thing this needs to be right about is
 * where a selector list ends. So it tracks strings, comments, brackets and brace depth, treats
 * anything before a `{` at depth zero as a selector list, and recurses into the at-rules that
 * contain selectors while leaving alone the ones that do not — `@keyframes` percentages are not
 * selectors, and `@font-face` has none.
 */
export function scopeCss(css: string, attribute: string): string {
  const out: string[] = []
  let i = 0
  let buffer = ''
  // Brace depth *inside* a rule body, so a nested at-rule's contents are still seen as selectors.
  let insideBody = 0
  // The at-rules whose bodies hold selectors, innermost last. A `@keyframes` pushes false.
  const selectorBlocks: boolean[] = []

  const flushSelectors = (): void => {
    const holdsSelectors = selectorBlocks.length === 0 || selectorBlocks[selectorBlocks.length - 1] === true
    out.push(holdsSelectors ? narrowList(buffer, attribute) : buffer)
    buffer = ''
  }

  while (i < css.length) {
    const ch = css[i] as string
    // Comments and strings travel as they are. A `{` inside either is not a block.
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      const stop = end === -1 ? css.length : end + 2
      buffer += css.slice(i, stop)
      i = stop
      continue
    }
    if (ch === '"' || ch === "'") {
      const stop = endOfString(css, i)
      buffer += css.slice(i, stop)
      i = stop
      continue
    }
    if (ch === '{') {
      if (insideBody > 0) {
        buffer += ch
        insideBody++
        i++
        continue
      }
      const head = buffer.trim()
      if (head.startsWith('@')) {
        // An at-rule's prelude is never a selector list, whatever its body holds.
        out.push(buffer, '{')
        selectorBlocks.push(AT_RULE_WITH_SELECTORS.test(head))
        buffer = ''
        i++
        continue
      }
      flushSelectors()
      out.push('{')
      insideBody = 1
      i++
      continue
    }
    if (ch === '}') {
      if (insideBody > 0) {
        insideBody--
        buffer += ch
        if (insideBody === 0) {
          out.push(buffer)
          buffer = ''
        }
        i++
        continue
      }
      out.push(buffer, '}')
      selectorBlocks.pop()
      buffer = ''
      i++
      continue
    }
    // A statement at-rule — `@import`, `@charset`, `@layer a, b;` — ends at its semicolon.
    if (ch === ';' && insideBody === 0) {
      out.push(buffer, ';')
      buffer = ''
      i++
      continue
    }
    buffer += ch
    i++
  }
  out.push(buffer)
  return out.join('')
}

function endOfString(css: string, start: number): number {
  const quote = css[start]
  let i = start + 1
  while (i < css.length) {
    if (css[i] === '\\') {
      i += 2
      continue
    }
    if (css[i] === quote) return i + 1
    i++
  }
  return css.length
}

/** A comma-separated selector list, each selector narrowed. Commas inside `:is(…)` are not splits. */
function narrowList(list: string, attribute: string): string {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (let i = 0; i < list.length; i++) {
    const ch = list[i] as string
    if (ch === '"' || ch === "'") {
      const stop = endOfString(list, i)
      current += list.slice(i, stop)
      i = stop - 1
      continue
    }
    if (ch === '(' || ch === '[') depth++
    if (ch === ')' || ch === ']') depth--
    if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts.map((part) => narrow(part, attribute)).join(',')
}

/**
 * One selector, with the attribute joined to its last compound.
 *
 * Leading and trailing whitespace is preserved, because the input carried the file's own formatting
 * and a stylesheet that comes back reflowed is a diff nobody asked for.
 */
function narrow(selector: string, attribute: string): string {
  const head = /^\s*/.exec(selector)?.[0] ?? ''
  const tail = /\s*$/.exec(selector)?.[0] ?? ''
  const body = selector.slice(head.length, selector.length - tail.length)
  if (!body) return selector

  const last = lastCompound(body)
  if (last === -1) return selector
  const compound = body.slice(last)
  const before = body.slice(0, last)
  // Before the first pseudo — `::after` and `:hover` alike filter a compound, so the attribute is
  // part of what they filter. A leading `&` or combinator stays where it is.
  const pseudo = firstPseudo(compound)
  const at = pseudo === -1 ? compound.length : pseudo
  return `${head}${before}${compound.slice(0, at)}[${attribute}]${compound.slice(at)}${tail}`
}

/** Where the last compound selector starts: after the final top-level combinator or space. */
function lastCompound(body: string): number {
  let depth = 0
  let start = 0
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] as string
    if (ch === '"' || ch === "'") {
      i = endOfString(body, i) - 1
      continue
    }
    if (ch === '(' || ch === '[') depth++
    if (ch === ')' || ch === ']') depth--
    if (depth > 0) continue
    if (ch === ' ' || ch === '>' || ch === '+' || ch === '~' || ch === '\n' || ch === '\t') start = i + 1
  }
  return start
}

/** The first `:` that begins a pseudo, skipping the ones inside brackets and functions. */
function firstPseudo(compound: string): number {
  let depth = 0
  for (let i = 0; i < compound.length; i++) {
    const ch = compound[i] as string
    if (ch === '"' || ch === "'") {
      i = endOfString(compound, i) - 1
      continue
    }
    if (ch === '(' || ch === '[') depth++
    if (ch === ')' || ch === ']') depth--
    if (ch === ':' && depth === 0) return i
  }
  return -1
}
