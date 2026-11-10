import type Ajv from 'ajv'
import { reportStyleValidators } from './schemaValidators'
import { copyJson } from './jsonData'
import { canonicalDigest } from './digest'
import type { ProfileMachine, StyleSnapshot } from './types'

function validator(name: 'snapshot' | 'profile' | 'report'): Ajv.ValidateFunction {
  return reportStyleValidators[name]
}

export function validateStyleJson<T>(
  name: 'snapshot' | 'profile' | 'report',
  input: unknown,
): T {
  const value = copyJson(input, {
    maxBytes: 32 * 1024 * 1024,
    maxDepth: 32,
    maxNodes: 1500000,
  })
  if (
    new TextEncoder().encode(JSON.stringify(value)).byteLength >
    (name === 'report' ? 128 * 1024 : 5 * 1024 * 1024)
  )
    throw new Error('Report style JSON exceeds serialized limit.')
  const validate = validator(name)
  if (!validate(value))
    throw new Error(
      `Invalid report style ${name}: ${JSON.stringify(validate.errors)}`,
    )
  if (name === 'snapshot')
    validateSnapshotReferences(value as unknown as StyleSnapshot)
  if (name === 'profile')
    validateProfileReferences(value as unknown as ProfileMachine)
  return value as T
}

function unique<T>(values: T[], label: string): Set<T> {
  const set = new Set(values)
  if (set.size !== values.length) throw new Error(`Duplicate ${label}.`)
  return set
}

export function validateSnapshotReferences(snapshot: StyleSnapshot, maxBytes = 4 * 1024 * 1024): void {
  if (
    new TextEncoder().encode(JSON.stringify(snapshot)).byteLength >
    maxBytes
  )
    throw new Error(`Snapshot exceeds ${maxBytes / (1024 * 1024)} MiB.`)
  const sections = unique(
    snapshot.sections.map((item) => item.ref),
    'section ref',
  )
  const nodes = new Map(snapshot.nodes.map((item) => [item.ref, item]))
  unique(
    snapshot.nodes.map((item) => item.ref),
    'node ref',
  )
  const assertRef = (ref: string) => {
    if (!nodes.has(ref)) throw new Error(`Unresolved node ref: ${ref}`)
  }
  const topOrders = new Set<string>()
  const verifiedAncestry = new Set<string>()
  for (const node of snapshot.nodes) {
    const section = node.ref.split('/')[0]
    if (!sections.has(section)) throw new Error('Unknown node section.')
    if (node.parentRef !== null) assertRef(node.parentRef)
    let parent = node.parentRef
    const seen = new Set([node.ref])
    while (parent !== null) {
      if (seen.has(parent)) throw new Error('Node parent cycle.')
      if (parent.split('/')[0] !== section)
        throw new Error('Cross-section parent.')
      if (verifiedAncestry.has(parent)) break
      seen.add(parent)
      const ancestor = nodes.get(parent)
      if (!ancestor) throw new Error(`Unresolved node ref: ${parent}`)
      parent = ancestor.parentRef
    }
    for (const ref of seen) verifiedAncestry.add(ref)
    if (node.topLevelOrder !== null) {
      const order = `${section}/${node.topLevelOrder}`
      if (node.parentRef !== null || topOrders.has(order))
        throw new Error('Invalid top-level order.')
      topOrders.add(order)
    }
  }
  unique(
    snapshot.paragraphs.map((p) => p.ref),
    'paragraph ref',
  )
  let runs = 0
  for (const p of snapshot.paragraphs) {
    if (
      nodes.get(p.ref)?.kind !== 'paragraph' ||
      !snapshot.paragraphStyles[p.paragraphStyle]
    )
      throw new Error('Unresolved paragraph/style reference.')
    let end = 0
    for (const run of p.runs) {
      if (
        !snapshot.characterStyles[run.characterStyle] ||
        run.start < end ||
        run.start + run.length > p.textCodePoints
      )
        throw new Error('Invalid run range/style reference.')
      end = run.start + run.length
      runs++
    }
    for (const candidate of p.candidates)
      for (const evidence of candidate.evidenceRefs)
        if (!evidence) throw new Error('Empty evidence ref.')
  }
  let cells = 0
  unique(
    snapshot.tables.map((table) => table.ref),
    'table ref',
  )
  const paragraphRefs = new Set(snapshot.paragraphs.map((p) => p.ref))
  for (const table of snapshot.tables) {
    if (nodes.get(table.ref)?.kind !== 'table')
      throw new Error('Unresolved table ref.')
    unique(
      table.cells.map((cell) => cell.ref),
      'cell ref',
    )
    const occupied = new Set<string>()
    for (const cell of table.cells) {
      if (
        nodes.get(cell.ref)?.kind !== 'cell' ||
        nodes.get(cell.ref)?.parentRef !== table.ref ||
        cell.row + cell.rowSpan > table.rowCount ||
        cell.column + cell.columnSpan > table.columnCount
      )
        throw new Error('Invalid cell reference/span.')
      if (cell.rowSpan * cell.columnSpan > 50000)
        throw new Error('Cell grid exceeds limit.')
      for (let row = cell.row; row < cell.row + cell.rowSpan; row++)
        for (
          let col = cell.column;
          col < cell.column + cell.columnSpan;
          col++
        ) {
          const key = `${row}/${col}`
          if (occupied.has(key)) throw new Error('Overlapping cells.')
          occupied.add(key)
          if (occupied.size > 50000) throw new Error('Cell grid exceeds limit.')
        }
      for (const ref of cell.paragraphRefs)
        if (!paragraphRefs.has(ref) || nodes.get(ref)?.parentRef !== cell.ref)
          throw new Error('Invalid cell paragraph ref.')
      cells++
    }
    if (table.columnRatios.state === 'measured') {
      const ratios = table.columnRatios.value
      if (
        ratios.length !== table.columnCount ||
        ratios.some((n) => n < 0) ||
        Math.abs(ratios.reduce((a, b) => a + b, 0) - 1) > 1e-6
      )
        throw new Error('Invalid column ratios.')
    }
  }
  if (runs > 50000 || cells > 50000)
    throw new Error('Snapshot aggregate budget exceeded.')
  for (const item of snapshot.unsupported) item.refs.forEach(assertRef)
}

export function validateProfileReferences(profile: ProfileMachine, snapshotLimit = 4 * 1024 * 1024): void {
  validateSnapshotReferences(profile.snapshot, snapshotLimit)
  unique(
    profile.bindings.map((binding) => binding.key),
    'binding key',
  )
  unique(
    profile.fixedRegions.map((fixed) => fixed.ref),
    'fixed region',
  )
  const paragraphs = new Set(profile.snapshot.paragraphs.map((p) => p.ref))
  const nodes = new Map(profile.snapshot.nodes.map((node) => [node.ref, node]))
  const inside = (ref: string, ancestor: string): boolean => {
    let cursor: string | null = ref
    while (cursor !== null) {
      if (cursor === ancestor) return true
      cursor = nodes.get(cursor)?.parentRef ?? null
    }
    return false
  }
  for (const binding of profile.bindings)
    if (!paragraphs.has(binding.representativeRef))
      throw new Error('Unresolved representative ref.')
  for (const fixed of profile.fixedRegions) {
    const node = nodes.get(fixed.ref)
    if (!node || node.topLevelOrder === null)
      throw new Error('Fixed region must be top-level.')
    if (
      profile.bindings.some((binding) =>
        inside(binding.representativeRef, fixed.ref),
      )
    )
      throw new Error('Fixed region overlaps a representative.')
    unique(
      fixed.replacements.map((replacement) => replacement.paragraphRef),
      'replacement ref',
    )
    for (const replacement of fixed.replacements)
      if (
        !paragraphs.has(replacement.paragraphRef) ||
        !inside(replacement.paragraphRef, fixed.ref)
      )
        throw new Error('Replacement outside fixed region.')
  }
}

export async function validateProfile(input: unknown): Promise<ProfileMachine> {
  const profile = validateStyleJson<ProfileMachine>('profile', input)
  if ((canonicalDigest(profile.snapshot)) !== profile.measurementSha256)
    throw new Error('Measurement digest mismatch.')
  if (
    profile.template &&
    (profile.template.derivedFromSourceSha256 !==
      profile.snapshot.source.sha256 ||
      profile.template.derivationSha256 !== (await derivationDigest(profile)))
  )
    throw new Error('Template derivation mismatch.')
  return profile
}

export async function derivationDigest(
  profile: Pick<
    ProfileMachine,
    'measurementSha256' | 'bindings' | 'fixedRegions'
  >,
): Promise<string> {
  return canonicalDigest({
    schema: 'report-style-derivation/1',
    measurementSha256: profile.measurementSha256,
    bindings: profile.bindings,
    fixedRegions: profile.fixedRegions,
  })
}
