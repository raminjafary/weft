export const TEMPLATE_IR_SPEC = 'weft.template-ir/1'
export const TEMPLATE_IR_VERSION = '1.0.0'

export const PAYLOAD_SPEC = 'weft.payload/1'
export const PAYLOAD_VERSION = '1.0.0'

export interface SemVer {
  major: number
  minor: number
  patch: number
}

export function parseVersion(v: string): SemVer {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v)
  if (!m) throw new Error(`E_VERSION_MALFORMED: ${v}`)
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  return x.major - y.major || x.minor - y.minor || x.patch - y.patch
}

export type AcceptMode = 'exact' | 'upgrade' | 'forward'

export type AcceptResult =
  | { ok: true; mode: AcceptMode; from: string; to: string }
  | { ok: false; code: 'E_SPEC_MISMATCH' | 'E_MAJOR_UNSUPPORTED' | 'E_VERSION_MALFORMED'; reason: string }

/**
 * The compatibility contract, which is the reason this package exists before any
 * framework code does. Major is a hard wire break. Minor is additive: an older
 * reader accepts a newer minor and must round-trip fields it does not understand.
 */
export function accepts(doc: { spec?: unknown; irVersion?: unknown }, reader = {
  spec: TEMPLATE_IR_SPEC,
  version: TEMPLATE_IR_VERSION,
}): AcceptResult {
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

export type Migration = (doc: Record<string, unknown>) => Record<string, unknown>

const migrations = new Map<string, { to: string; run: Migration }>()

export function registerMigration(from: string, to: string, run: Migration): void {
  if (compareVersions(from, to) >= 0) throw new Error(`E_MIGRATION_DIRECTION: ${from} -> ${to}`)
  if (parseVersion(from).major !== parseVersion(to).major) {
    throw new Error(`E_MIGRATION_MAJOR: ${from} -> ${to} crosses a major, which is a wire break`)
  }
  migrations.set(from, { to, run })
}

export function clearMigrations(): void {
  migrations.clear()
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
    if (++guard > 64) throw new Error('E_MIGRATION_CYCLE')
  }
  return { doc: current, applied }
}
