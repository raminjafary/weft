/** A position in a source file, so a refusal can name the line rather than the offset. */
export interface Loc {
  file: string
  line: number
  column: number
}

/** A compile error names a location and a code, so a miscompile is never silent. */
export class CompileError extends Error {
  code: string
  loc: Loc

  constructor(code: string, message: string, loc: Loc) {
    super(`${code} at ${loc.file}:${loc.line}:${loc.column} — ${message}`)
    this.name = 'CompileError'
    this.code = code
    this.loc = loc
  }
}

/** A byte offset as a line and column. */
export function locate(file: string, source: string, offset = 0): Loc {
  const upto = source.slice(0, offset)
  const lines = upto.split('\n')
  return { file, line: lines.length, column: (lines[lines.length - 1] ?? '').length + 1 }
}
