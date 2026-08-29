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

/** How a document was accepted: unchanged, migrated up, or read as-is by a newer reader. See `spec/VERSIONING.md`. */
export type AcceptMode = 'exact' | 'upgrade' | 'forward'

/** Whether this reader can read that document, and if not, which refusal applies. */
export type AcceptResult =
  | { ok: true; mode: AcceptMode; from: string; to: string }
  | { ok: false; code: 'E_SPEC_MISMATCH' | 'E_MAJOR_UNSUPPORTED' | 'E_VERSION_MALFORMED'; reason: string }

/** The compatibility contract. Major is a hard wire break; minor is additive. See `spec/VERSIONING.md`. */
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

/** Register a step from one minor to the next. Refuses a step that does not go forward, or crosses a major. */
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

/** The built-in migration chain. See `spec/ir/template-ir-2.md`: Version history. */
function installBuiltIns(): void {
  registerMigration('2.0.0', '2.1.0', (doc) => doc)
  registerMigration('2.1.0', '2.2.0', (doc) => ({ ...doc, derived: doc.derived ?? [] }))
  registerMigration('2.2.0', '2.3.0', (doc) => doc)
  registerMigration('2.3.0', '2.4.0', (doc) => doc)
  registerMigration('2.4.0', '2.5.0', (doc) => doc)
  registerMigration('2.5.0', '2.6.0', (doc) => doc)
}

installBuiltIns()
