// Validation of provisional compact transport; existing snapshot/1 limits stay unchanged.
import type Ajv from 'ajv'
import { copyJson } from './jsonData'
import { canonicalDigest } from './digest'
import { validateSnapshotReferences } from './schema'
import { reportStyleValidators } from './schemaValidators'
import type { StyleSnapshot } from './types'

const EXPANDED_LIMIT = 16 * 1024 * 1024

export async function validateExpandedSnapshot(input: unknown, measurementSha256: string, sourceSha256: string): Promise<StyleSnapshot> {
  if (typeof measurementSha256 !== 'string' || typeof sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(measurementSha256) || !/^[a-f0-9]{64}$/.test(sourceSha256)) throw new Error('Expected measurement and source digests are required.')
  const value = copyJson(input, { maxBytes: 4 * EXPANDED_LIMIT, maxDepth: 32, maxNodes: 1500000 })
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > EXPANDED_LIMIT) throw new Error('Expanded snapshot exceeds 16 MiB.')
  const validate: Ajv.ValidateFunction = reportStyleValidators.snapshot
  if (!validate(value)) throw new Error('Invalid expanded snapshot schema.')
  const snapshot = value as unknown as StyleSnapshot
  validateSnapshotReferences(snapshot, EXPANDED_LIMIT)
  if (snapshot.source.sha256 !== sourceSha256 || canonicalDigest(snapshot) !== measurementSha256) throw new Error('Expanded snapshot digest mismatch.')
  return snapshot
}
