/** Marker spellings supported by the template loader and E1 derivation. */
export const VARIANT_MARKER_BASES = [
  'BODY',
  'CODE',
  'QUOTE',
  'HR',
  'CAPTION',
  'TABLE_CAPTION',
  'FOOTNOTE',
  ...Array.from({ length: 9 }, (_, index) => `H${index + 1}`),
  'CELL_BODY',
  ...['HEADER', 'TOP', 'MIDDLE', 'BOTTOM'].flatMap((row) =>
    ['LEFT', 'CENTER', 'RIGHT'].map((column) => `CELL_${row}_${column}`),
  ),
  'CELL_NUMBER',
  'CELL_STUB',
  'CELL_ODD',
  'CELL_EVEN',
  ...['ODD', 'EVEN'].flatMap((row) =>
    ['LEFT', 'CENTER', 'RIGHT'].map((column) => `CELL_${row}_${column}`),
  ),
] as const

const names = new Set<string>(VARIANT_MARKER_BASES)
const variantName =
  /^(?!(?:fixed|omitted|style|decomposition|meta)$)[\p{L}\p{N}_]{1,12}$(?![\s\S])/u

export function parseVariantMarker(
  marker: string,
): { base: string; variant: string } | null {
  const split = marker.indexOf(':')
  if (split < 0) return null
  const base = marker.slice(0, split),
    variant = marker.slice(split + 1)
  if (!names.has(base) || !variantName.test(variant)) return null
  // The block loader reserves "1" for numbered-heading rules even for BODY.
  if (!base.startsWith('CELL_') && variant === '1') return null
  return { base, variant }
}
