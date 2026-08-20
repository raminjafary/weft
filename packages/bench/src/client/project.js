/**
 * The client half of the `data` form: values arrive, the template is already resident,
 * and the region is produced locally. Segments are joined and handed to the HTML parser
 * rather than assembled node by node, because the parser is native code and a JavaScript
 * DOM-construction path is the thing this design exists to avoid.
 */
export function project(template, values) {
  return join(template.root, values, template)
}

function join(node, values, template) {
  let out = ''
  for (let i = 0; i < node.parts.length; i++) {
    out += node.parts[i]
    const hole = node.holes[i]
    if (!hole) continue
    const value = values[hole.binding]
    switch (hole.kind) {
      case 'slot':
        break
      case 'attr-bool':
        if (truthy(value)) out += hole.attr
        break
      case 'list':
        if (Array.isArray(value)) {
          for (const item of value) out += join(template.row, item, template)
        }
        break
      default:
        out += hole.escape === 'trusted-raw' ? text(value) : escape(text(value), hole.kind === 'attr')
    }
  }
  return out
}

function text(v) {
  if (v === null || v === undefined) return ''
  return typeof v === 'string' ? v : String(v)
}

function truthy(v) {
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0
}

function escape(s, attr) {
  let out = s
  if (out.indexOf('&') >= 0) out = out.replace(/&/g, '&amp;')
  if (out.indexOf('<') >= 0) out = out.replace(/</g, '&lt;')
  if (out.indexOf('>') >= 0) out = out.replace(/>/g, '&gt;')
  if (attr && out.indexOf('"') >= 0) out = out.replace(/"/g, '&quot;')
  return out
}

export function applyDelta(base, changed) {
  const next = structuredClone(base)
  for (const path of Object.keys(changed)) {
    const tokens = path.split('.')
    let cursor = next
    tokens.forEach((token, i) => {
      const match = /^([^[]+)(?:\[(\d+)\])?$/.exec(token)
      const key = match[1]
      const index = match[2] === undefined ? undefined : Number(match[2])
      const last = i === tokens.length - 1
      if (last && index === undefined) {
        cursor[key] = changed[path]
        return
      }
      if (index === undefined) {
        cursor = cursor[key]
        return
      }
      if (last) {
        cursor[key][index] = changed[path]
        return
      }
      cursor = cursor[key][index]
    })
  }
  return next
}
