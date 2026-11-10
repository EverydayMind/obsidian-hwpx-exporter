// Provisional v1 envelope; older readers reject its distinct block.
import { decodeCompactSnapshot } from './compactSnapshot'
import { decodeCompactEvidence } from './compactEvidence'
import { validateExpandedProfile } from './expandedProfile'
import { parseNote } from './noteCodec'
import { type ProfileV2, validateExpandedProfileV2 } from './profileV2'
import type { ProfileMachine } from './types'

export function parseCompactProfileNote(note: string) {
  return parseNote<ProfileMachine | ProfileV2>(note, async (value) => {
    if (value && typeof value === 'object' && 'schema' in value && value.schema === 'report-style-profile/2') return validateExpandedProfileV2(value)
    return validateExpandedProfile(value)
  }, {
    async decode(value, frontmatter) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || typeof frontmatter.measurement_sha256 !== 'string' || typeof frontmatter.source_sha256 !== 'string') throw new Error('Invalid compact profile envelope.')
      const wire = value as Record<string, unknown>
      const snapshot = await decodeCompactSnapshot(wire.snapshot, frontmatter.measurement_sha256, frontmatter.source_sha256)
      const replay = wire.semanticReplay
      const semanticReplay = replay && typeof replay === 'object' && !Array.isArray(replay) ? { ...replay, evidence: decodeCompactEvidence((replay as Record<string, unknown>).evidence) } : replay
      const profile = { ...wire, snapshot, ...(replay === undefined ? {} : { semanticReplay }) }
      return wire.schema === 'report-style-profile/2' ? validateExpandedProfileV2(profile) : validateExpandedProfile(profile)
    },
  })
}
