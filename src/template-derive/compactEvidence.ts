// Provisional text-free evidence transport; profile validation remains authoritative.
const tag = 'verbex-semantic-evidence-intern/0.1'
const limit = 4 * 1024 * 1024
const bytes = (value: string) => new TextEncoder().encode(value).byteLength
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

export function encodeCompactEvidence(input: unknown): unknown {
  if (!record(input) || !Array.isArray(input.nodes))
    throw new Error('Invalid semantic evidence.')
  const { nodes, ...metadata } = input
  const atoms: Record<string, unknown>[] = []
  const indices = new Map<string, number>()
  const refs = nodes.map((node: unknown) => {
    if (!record(node) || typeof node.ref !== 'string')
      throw new Error('Invalid semantic evidence node.')
    const { ref, ...atom } = node
    const key = JSON.stringify(atom)
    let index = indices.get(key)
    if (index === undefined) {
      index = atoms.length
      indices.set(key, index)
      atoms.push(atom)
    }
    return [ref, index]
  })
  const packed = { schema: tag, metadata, atoms, nodes: refs }
  return bytes(JSON.stringify(packed)) < bytes(JSON.stringify(input))
    ? packed
    : input
}

export function decodeCompactEvidence(input: unknown): unknown {
  if (!record(input) || input.schema !== tag) return input
  if (
    Object.keys(input).sort().join(',') !== 'atoms,metadata,nodes,schema' ||
    !record(input.metadata) ||
    'nodes' in input.metadata ||
    !Array.isArray(input.atoms) ||
    input.atoms.length > 10000 ||
    !Array.isArray(input.nodes) ||
    input.nodes.length > 10000
  )
    throw new Error('Invalid compact semantic evidence.')
  if (input.atoms.some((atom: unknown) => !record(atom) || 'ref' in atom))
    throw new Error('Invalid compact semantic atom.')
  const atoms = input.atoms as Record<string, unknown>[]
  let total = bytes(JSON.stringify({ ...input.metadata, nodes: [] }))
  const nodes = input.nodes.map((entry: unknown, position: number) => {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== 'string' ||
      !Number.isSafeInteger(entry[1]) ||
      entry[1] < 0 ||
      entry[1] >= atoms.length
    )
      throw new Error('Invalid compact semantic index.')
    const node = { ref: entry[0], ...atoms[entry[1] as number] }
    total += bytes(JSON.stringify(node)) + (position === 0 ? 0 : 1)
    if (total > limit)
      throw new Error('Expanded semantic evidence exceeds 4 MiB.')
    return node
  })
  const evidence = { ...input.metadata, nodes }
  if (bytes(JSON.stringify(evidence)) > limit)
    throw new Error('Expanded semantic evidence exceeds 4 MiB.')
  return evidence
}
