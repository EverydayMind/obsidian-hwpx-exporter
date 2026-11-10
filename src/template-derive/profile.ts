import { parseNote, renderNote } from './noteCodec'
import { parseCompactProfileNote } from './compactProfileNote'
import { type ProfileV2, validateProfileV2 } from './profileV2'
import { validateProfile } from './schema'
import type { ProfileMachine } from './types'

export function profileSummary(profile: ProfileMachine) {
  return {
    title: profile.title,
    revision: profile.revision,
    sourcePath: profile.sourcePath,
    sourceSha256: profile.snapshot.source.sha256,
    measurementSha256: profile.measurementSha256,
    sections: profile.snapshot.sections.slice(0, 4),
    sectionCount: profile.snapshot.sections.length,
    sectionsTruncated: profile.snapshot.sections.length > 4,
    paragraphs: profile.snapshot.paragraphs.length,
    tables: profile.snapshot.tables.length,
    characterStyles: profile.snapshot.characterStyles.length,
    paragraphStyles: profile.snapshot.paragraphStyles.length,
    bindings: profile.bindings.length,
    fixedRegions: profile.fixedRegions.length,
    template: profile.template,
    unsupported: profile.snapshot.unsupported.slice(0, 50).map((item) => ({
      feature: item.feature,
      refs: item.refs.slice(0, 20),
      totalRefs: item.refs.length,
    })),
    layout: { state: 'not_measured' },
  }
}

export type ParsedProfileNote = { machine: ProfileMachine; guidance: string; newline: string }
export const parseProfileNote = (note: string) => parseNote(note, validateProfile)
export const renderProfileNote = (profile: ProfileMachine, guidance: string, newline = '\n') => renderNote(profile, guidance, newline, validateProfile)
export const parseProfileV2Note = (note: string) => parseNote(note, validateProfileV2)
export const renderProfileV2Note = (profile: ProfileV2, guidance: string, newline = '\n') => renderNote(profile, guidance, newline, validateProfileV2)
export const parseAnyProfileNote = (note: string) => /<!-- verbex:report-style:machine:start -->\r?\n```report-style-compact-profile-json\r?\n/.test(note) ? parseCompactProfileNote(note) : parseNote<ProfileMachine | ProfileV2>(note, (input) => {
  if (input && typeof input === 'object' && 'schema' in input && input.schema === 'report-style-profile/2') return validateProfileV2(input)
  return validateProfile(input)
})
