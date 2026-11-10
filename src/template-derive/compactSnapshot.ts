// Provisional transport decoder, independent of KORDOC and not snapshot/2.
import { copyJson } from './jsonData'
import type { JsonValue } from './jsonData'

import { validateExpandedSnapshot } from './expandedSnapshot'
import type { StyleSnapshot } from './types'

const PACKED_LIMIT = 4 * 1024 * 1024
const EXPANDED_LIMIT = 16 * 1024 * 1024
const sides = ['left', 'right', 'top', 'bottom']
const languages = [
  'hangul',
  'latin',
  'hanja',
  'japanese',
  'other',
  'symbol',
  'user',
]
const fields = ['fonts', 'ratioPct', 'spacingPct']
type ObjectValue = Record<string, JsonValue>
const record = (value: JsonValue | undefined): value is ObjectValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (
  value: JsonValue | undefined,
  keys: string[],
): value is ObjectValue =>
  record(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
const bytes = (value: string) => new TextEncoder().encode(value).byteLength
const canonical = (value: JsonValue): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`
}
function bad(message: string): never {
  throw new Error(message)
}

function expandCellStyle(value: JsonValue, ref: string): ObjectValue {
  if (
    !exact(value, ['borders', 'fillRgb', 'paddingPt']) ||
    !exact(value.borders, sides) ||
    !exact(value.paddingPt, sides)
  )
    return bad('Invalid cell style.')
  const atom = (item: JsonValue): JsonValue => {
    if (
      !record(item) ||
      !Object.prototype.hasOwnProperty.call(item, 'evidenceRef')
    )
      return bad('Invalid style atom.')
    let evidence = item.evidenceRef
    if (record(evidence)) {
      if (!exact(evidence, ['cell']) || evidence.cell !== true)
        return bad('Invalid self-reference marker.')
      evidence = ref
    } else if (typeof evidence !== 'string') return bad('Invalid evidence ref.')
    return { ...item, evidenceRef: evidence }
  }
  return {
    borders: Object.fromEntries(
      sides.map((side) => [side, atom((value.borders as ObjectValue)[side])]),
    ),
    fillRgb: atom(value.fillRgb),
    paddingPt: Object.fromEntries(
      sides.map((side) => [side, atom((value.paddingPt as ObjectValue)[side])]),
    ),
  }
}

/** Decode bounded untrusted transport, then independently validate both hashes. */
export async function decodeCompactSnapshot(
  input: unknown,
  measurementSha256: string,
  sourceSha256: string,
): Promise<StyleSnapshot> {
  if (
    typeof measurementSha256 !== 'string' ||
    typeof sourceSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(measurementSha256) ||
    !/^[a-f0-9]{64}$/.test(sourceSha256)
  )
    return bad('Expected digests required.')
  const packed = copyJson(input, {
    maxBytes: 4 * PACKED_LIMIT,
    maxDepth: 32,
    maxNodes: 1500000,
  })
  const packedBytes = bytes(JSON.stringify(packed))
  if (packedBytes > PACKED_LIMIT) return bad('Packed snapshot exceeds 4 MiB.')
  if (
    !exact(packed, [
      'format',
      'measurementSha256',
      'snapshot',
      'styles',
      'languageAtoms',
    ]) ||
    packed.format !== 'kordoc-style-intern-experiment/0.2' ||
    packed.measurementSha256 !== measurementSha256 ||
    !record(packed.snapshot) ||
    !Array.isArray(packed.snapshot.tables) ||
    !Array.isArray(packed.snapshot.characterStyles) ||
    packed.snapshot.characterStyles.length > 4096 ||
    !Array.isArray(packed.styles) ||
    packed.styles.length > 4096 ||
    !Array.isArray(packed.languageAtoms) ||
    packed.languageAtoms.length > 4096 * 7 * 3
  )
    return bad('Invalid packed snapshot.')
  const styles = packed.styles,
    atoms = packed.languageAtoms
  const seenStyles = new Set<string>(),
    seenAtoms = new Set<string>()
  const styleBytes = styles.map((style) => {
    expandCellStyle(style, '')
    const key = canonical(style)
    if (seenStyles.has(key)) return bad('Duplicate cell style.')
    seenStyles.add(key)
    return bytes(key)
  })
  const atomBytes = atoms.map((atom) => {
    if (!record(atom)) return bad('Invalid language atom.')
    const key = canonical(atom)
    if (seenAtoms.has(key)) return bad('Duplicate language atom.')
    seenAtoms.add(key)
    return bytes(key)
  })
  let estimate = packedBytes,
    cells = 0
  const usedStyles = new Set<number>(),
    usedAtoms = new Set<number>()
  const account = (amount: number) => {
    estimate += amount
    if (estimate > EXPANDED_LIMIT) bad('Expanded snapshot exceeds limit.')
  }
  const indexOf = (value: JsonValue | undefined, length: number): number => {
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value >= length
    )
      return bad('Invalid dictionary index.')
    return value
  }
  for (const style of packed.snapshot.characterStyles) {
    if (!record(style)) return bad('Invalid character style.')
    for (const field of fields) {
      const values = style[field]
      if (!exact(values, languages)) return bad('Invalid language fields.')
      for (const language of languages) {
        const index = indexOf(values[language], atoms.length)
        usedAtoms.add(index)
        account(atomBytes[index] + 64)
      }
    }
  }
  if (usedAtoms.size !== atoms.length) return bad('Unused language atom.')
  for (const table of packed.snapshot.tables) {
    if (!record(table) || !Array.isArray(table.cells))
      return bad('Invalid table.')
    for (const cell of table.cells) {
      if (
        !record(cell) ||
        typeof cell.ref !== 'string' ||
        ['borders', 'fillRgb', 'paddingPt'].some((key) =>
          Object.prototype.hasOwnProperty.call(cell, key),
        )
      )
        return bad('Invalid cell.')
      const index = indexOf(cell.styleIndex, styles.length)
      if (++cells > 50000) return bad('Too many cells.')
      usedStyles.add(index)
      account(styleBytes[index] + 9 * bytes(JSON.stringify(cell.ref)) + 128)
    }
  }
  if (usedStyles.size !== styles.length) return bad('Unused cell style.')
  const characterStyles = packed.snapshot.characterStyles.map((entry) => {
    const style = entry as ObjectValue,
      result = { ...style }
    for (const field of fields) {
      const values = style[field] as ObjectValue
      result[field] = Object.fromEntries(
        languages.map((language) => [
          language,
          { ...(atoms[values[language] as number] as ObjectValue) },
        ]),
      )
    }
    return result
  })
  const tables = packed.snapshot.tables.map((entry) => {
    const table = entry as ObjectValue
    return {
      ...table,
      cells: (table.cells as JsonValue[]).map((entry) => {
        const cell = entry as ObjectValue,
          { styleIndex, ...rest } = cell
        return {
          ...rest,
          ...expandCellStyle(styles[styleIndex as number], cell.ref as string),
        }
      }),
    }
  })
  return validateExpandedSnapshot(
    { ...packed.snapshot, characterStyles, tables },
    measurementSha256,
    sourceSha256,
  )
}
