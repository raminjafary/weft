/** The format name, carried in every document. A different name is a different format, not a version. */
export const TEMPLATE_IR_SPEC = 'weft.template-ir/2'
/** The version this build writes. Minors are forward-compatible; a major is refused. */
export const TEMPLATE_IR_VERSION = '2.6.0'

/** The format name for a delta or patch payload, versioned separately from the template. */
export const PAYLOAD_SPEC = 'weft.payload/2'
/** The payload version this build writes. */
export const PAYLOAD_VERSION = '2.6.0'

/** A parsed version. Nothing here compares versions as strings, because `2.10` sorts wrong. */
export interface SemVer {
  major: number
  minor: number
  patch: number
}

/** A version string as numbers. Refuses anything that is not major.minor.patch. */
export function parseVersion(v: string): SemVer {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v)
  // Terse: `accepts` is reachable from the document request path, which has a byte budget.
  if (!m) throw new Error(`E_VERSION_MALFORMED: ${v} is not semver`)
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

/** Negative, zero or positive, by major then minor then patch. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  return x.major - y.major || x.minor - y.minor || x.patch - y.patch
}

/**
 * How a document was accepted: unchanged, migrated up, or read as-is by a newer reader.
 *
 * `forward` is the interesting one — a reader on 2.6 reading a 2.4 document with no migration
 * registered — and it is reported rather than silent, because a field a reader does not know about
 * is a field it will not preserve.
 */
export type AcceptMode = 'exact' | 'upgrade' | 'forward'

/** Whether this reader can read that document, and if not, which refusal applies. */
export type AcceptResult =
  | { ok: true; mode: AcceptMode; from: string; to: string }
  | { ok: false; code: 'E_SPEC_MISMATCH' | 'E_MAJOR_UNSUPPORTED' | 'E_VERSION_MALFORMED'; reason: string }

/**
 * The compatibility contract, which is the reason this package exists before any
 * framework code does. Major is a hard wire break. Minor is additive: an older
 * reader accepts a newer minor and must round-trip fields it does not understand.
 */
export function accepts(
  doc: { spec?: unknown; irVersion?: unknown },
  reader = {
    spec: TEMPLATE_IR_SPEC,
    version: TEMPLATE_IR_VERSION,
  },
): AcceptResult {
  if (typeof doc.spec !== 'string' || doc.spec !== reader.spec) {
    return {
      ok: false,
      code: 'E_SPEC_MISMATCH',
      reason: `expected spec ${reader.spec}, got ${String(doc.spec)}`,
    }
  }
  if (typeof doc.irVersion !== 'string') {
    return { ok: false, code: 'E_VERSION_MALFORMED', reason: `irVersion is not a string` }
  }
  let found: SemVer
  let mine: SemVer
  try {
    found = parseVersion(doc.irVersion)
    mine = parseVersion(reader.version)
  } catch (e) {
    return { ok: false, code: 'E_VERSION_MALFORMED', reason: (e as Error).message }
  }
  if (found.major !== mine.major) {
    return {
      ok: false,
      code: 'E_MAJOR_UNSUPPORTED',
      reason: `reader speaks ${reader.spec} v${mine.major}.x, document is v${found.major}.x`,
    }
  }
  const cmp = compareVersions(doc.irVersion, reader.version)
  const mode: AcceptMode = cmp === 0 ? 'exact' : cmp < 0 ? 'upgrade' : 'forward'
  return { ok: true, mode, from: doc.irVersion, to: reader.version }
}

/** One version step. Pure: it takes a document and returns the next one, and never mutates. */
export type Migration = (doc: Record<string, unknown>) => Record<string, unknown>

const migrations = new Map<string, { to: string; run: Migration }>()

/**
 * Register a step from one minor to the next.
 *
 * Refuses a step that does not go forward and one that crosses a major, because a major is a wire
 * break rather than a shape somebody can convert.
 */
export function registerMigration(from: string, to: string, run: Migration): void {
  if (compareVersions(from, to) >= 0) {
    throw new Error(`E_MIGRATION_DIRECTION: ${from} -> ${to} is not forward; downgrades are undefined`)
  }
  if (parseVersion(from).major !== parseVersion(to).major) {
    throw new Error(`E_MIGRATION_MAJOR: ${from} -> ${to} crosses a major, which is a wire break`)
  }
  migrations.set(from, { to, run })
}

/** Drops every registered step. For tests: a migration table that leaks between them proves nothing. */
export function clearMigrations(): void {
  migrations.clear()
}

/** Clears test-local migrations and puts the built-in chain back. */
export function resetMigrations(): void {
  migrations.clear()
  installBuiltIns()
}

/** Chains registered migrations until the document reaches the reader's version. */
export function migrate(
  doc: Record<string, unknown>,
  target = TEMPLATE_IR_VERSION,
): { doc: Record<string, unknown>; applied: string[] } {
  const applied: string[] = []
  let current = doc
  let guard = 0
  while (typeof current.irVersion === 'string' && compareVersions(current.irVersion, target) < 0) {
    const step = migrations.get(current.irVersion)
    if (!step) {
      throw new Error(
        `E_MIGRATION_MISSING: no migration from ${current.irVersion}; document is older than this reader and cannot be upgraded`,
      )
    }
    applied.push(`${current.irVersion} -> ${step.to}`)
    current = { ...step.run(current), irVersion: step.to }
    if (++guard > 64) throw new Error('E_MIGRATION_CYCLE: registered steps lead in a circle')
  }
  return { doc: current, applied }
}

/**
 * 2.5.0 -> 2.6.0 narrowed `forms`: `patch` is derived rather than unconditional, because a `raw()`
 * value that is not its element's only child produced nodes with no boundary a structural write can
 * address. A 2.5.0 document may therefore advertise `patch` for a template that cannot serve it —
 * the migration restamps and `validate` names it `E_FORM_UNPROVABLE`, which is the honest outcome:
 * the form is refused where it is declared rather than declining later, in a refresh.
 *
 * 2.4.0 -> 2.5.0 added the `children` hole kind and the `children` field on a component hole:
 * the markup a call site wrote between the tags, sealed as its own template in the *caller's*
 * binding namespace. A 2.4.0 document has neither, so the migration restamps.
 *
 * 2.3.0 -> 2.4.0 added `isolated` on a component hole: the instance is its own cache unit
 * and the parent does not render it. A 2.3.0 document has none, so the migration restamps.
 *
 * 2.2.0 -> 2.3.0 added the `component` hole kind, which projects a parent's values through
 * a sealed child template. A 2.2.0 document has none, so the migration restamps and changes
 * nothing else.
 *
 * 2.1.0 -> 2.2.0 added `derived`, the table of values computed from other bindings. A
 * 2.1.0 document simply has none, so the migration is a default rather than a rewrite.
 *
 * 2.0.0 -> 2.1.0 put `anchor` on holes as well as wiring entries, so a consumer can
 * locate any text hole rather than only the ones a signal writes to. A 2.0.0 document is
 * already valid: its text holes simply carry no anchor, and a client falls back to the
 * region-level path. The 1.x chain went with the major, because a migration may not
 * cross one.
 */
function installBuiltIns(): void {
  registerMigration('2.0.0', '2.1.0', (doc) => doc)
  registerMigration('2.1.0', '2.2.0', (doc) => ({ ...doc, derived: doc.derived ?? [] }))
  registerMigration('2.2.0', '2.3.0', (doc) => doc)
  registerMigration('2.3.0', '2.4.0', (doc) => doc)
  registerMigration('2.4.0', '2.5.0', (doc) => doc)
  registerMigration('2.5.0', '2.6.0', (doc) => doc)
}

installBuiltIns()
