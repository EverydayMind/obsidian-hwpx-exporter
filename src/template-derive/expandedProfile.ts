// Internal validation for a profile decoded from provisional compact transport.
// Existing snapshot/1 profile readers retain their 4 MiB limit.
import type Ajv from 'ajv'
import { copyJson, UnsafeValueError } from './jsonData'
import { canonicalDigest } from './digest'
import { derivationDigest, validateProfileReferences } from './schema'
import { reportStyleValidators } from './schemaValidators'
import type { ProfileMachine } from './types'

const SNAPSHOT_LIMIT = 16 * 1024 * 1024
const PROFILE_LIMIT = 17 * 1024 * 1024

export async function validateExpandedProfile(input: unknown): Promise<ProfileMachine> {
  const value = copyJson(input, { maxDepth: 32, maxNodes: 1500000, maxBytes: 4 * PROFILE_LIMIT })
  return validateOwnedExpandedProfile(value, false)
}

/** Internal only: input is already an isolated bounded JSON copy. */
export async function validateOwnedExpandedProfile(value: unknown, checkBudget = true): Promise<ProfileMachine> {
  if (checkBudget) assertOwnedBudget(value)
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > PROFILE_LIMIT) throw new Error('Expanded profile exceeds 17 MiB.')
  const validate: Ajv.ValidateFunction = reportStyleValidators.profile
  if (!validate(value)) throw new Error('Invalid expanded profile schema.')
  const profile = value as ProfileMachine
  validateProfileReferences(profile, SNAPSHOT_LIMIT)
  if (canonicalDigest(profile.snapshot) !== profile.measurementSha256) throw new Error('Measurement digest mismatch.')
  if (profile.template && (profile.template.derivedFromSourceSha256 !== profile.snapshot.source.sha256 || profile.template.derivationSha256 !== (await derivationDigest(profile)))) throw new Error('Template derivation mismatch.')
  return profile
}

function assertOwnedBudget(value: unknown): void {
  let nodes = 0, bytes = 0
  const spend = (amount: number) => {
    bytes += amount
    if (++nodes > 1500000) throw new UnsafeValueError('too many nodes')
    if (bytes > 4 * PROFILE_LIMIT) throw new UnsafeValueError('value too large')
  }
  const visit = (item: unknown, depth: number): void => {
    if (depth > 32) throw new UnsafeValueError('value too deep')
    if (item === null || typeof item === 'boolean') { spend(5); return }
    if (typeof item === 'string') { spend(item.length * 3 + 2); return }
    if (typeof item === 'number') { spend(24); return }
    if (typeof item !== 'object') throw new Error('Invalid owned JSON value.')
    spend(2)
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1)
    } else {
      for (const [key, child] of Object.entries(item)) {
        spend(key.length * 3 + 3)
        visit(child, depth + 1)
      }
    }
  }
  visit(value, 0)
}
