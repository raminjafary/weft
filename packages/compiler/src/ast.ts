export interface Node {
  type: string
  start?: number
  end?: number
  [key: string]: unknown
}

export function node(value: unknown): Node {
  return value as Node
}

export function nodes(value: unknown): Node[] {
  return (value ?? []) as Node[]
}

export function name(value: unknown): string {
  const n = node(value)
  return String(n.name ?? '')
}

/** HTML elements with no closing tag. */
export const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
])

/** Attributes whose presence is the value. */
/**
 * Attributes that are the *default* rather than the current state. Once a user edits the
 * control, the property and the attribute disagree, and writing the attribute changes
 * nothing the user can see. These bind to the property instead — the IR has carried a
 * `prop` op for exactly this since 2.0.0.
 */
export const PROPERTY_BOUND: Record<string, ReadonlySet<string>> = {
  input: new Set(['value', 'checked', 'indeterminate']),
  textarea: new Set(['value']),
  select: new Set(['value']),
  option: new Set(['selected']),
  progress: new Set(['value']),
}

export function bindsToProperty(tag: string, attr: string): boolean {
  return PROPERTY_BOUND[tag]?.has(attr) ?? false
}

export const BOOLEAN_ATTRIBUTES = new Set([
  'allowfullscreen',
  'async',
  'autofocus',
  'autoplay',
  'checked',
  'controls',
  'default',
  'defer',
  'disabled',
  'formnovalidate',
  'hidden',
  'inert',
  'ismap',
  'itemscope',
  'loop',
  'multiple',
  'muted',
  'nomodule',
  'novalidate',
  'open',
  'playsinline',
  'readonly',
  'required',
  'reversed',
  'selected',
])

/**
 * JSX text semantics: a run of whitespace containing a newline collapses, and
 * whitespace-only lines disappear. Single-line text is preserved exactly, spaces included.
 */
export function trimJsxText(raw: string): string {
  if (!raw.includes('\n')) return raw
  const lines = raw.split('\n')
  let out = ''
  lines.forEach((line, i) => {
    let text = line
    if (i > 0) text = text.replace(/^[ \t\r]+/, '')
    if (i < lines.length - 1) text = text.replace(/[ \t\r]+$/, '')
    if (!text) return
    out = out ? `${out} ${text}` : text
  })
  return out
}

export function isSurviving(child: Node): boolean {
  if (child.type === 'JSXText') return trimJsxText(String(child.value ?? '')) !== ''
  if (child.type === 'JSXExpressionContainer') return node(child.expression).type !== 'JSXEmptyExpression'
  return true
}
