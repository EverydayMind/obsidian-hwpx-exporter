import type Ajv from 'ajv'
import { copyJson } from './jsonData'
import { canonicalDigest } from './digest'
import { derivationDigest, validateStyleJson } from './schema'
import { validateOwnedExpandedProfile } from './expandedProfile'
import { reportStyleValidators } from './schemaValidators'
import type { Binding, ProfileMachine } from './types'
import { parseVariantMarker } from './variantMarkers'
import { type SemanticReplay, validReplayBinding } from './semanticReplay'

export type SemanticAssignment = {
  ref: string
  role: string
  level?: number
  semanticParentRef?: string | null
  discourseRole?:
    | 'BACKGROUND'
    | 'STATUS'
    | 'PROBLEM'
    | 'OBJECTIVE'
    | 'ACTION'
    | 'EFFECT'
    | 'SUMMARY'
    | 'OTHER'
  assignedBy: 'model' | 'user'
}
export type RoleStyleVariant = {
  role: string | null
  variant: string | null
  marker: string
  representativeRef: string
  context: { container?: string; parentRole?: string }
  preferred: boolean
  assignedBy: 'rule' | 'model' | 'user' | 'migrated'
  legacy?: { key: string; assignedBy: Binding['assignedBy'] }
}
export type ProfileV2 = Omit<
  ProfileMachine,
  'schema' | 'bindings' | 'template'
> & {
  schema: 'report-style-profile/2'
  analysis: { state: 'unavailable'; reason: 'snapshot_v1' }
  analysisSha256: null
  semanticReplay?: SemanticReplay
  semantics: SemanticAssignment[]
  semanticsSha256: string
  roleStyleMap: RoleStyleVariant[]
  stats: { state: 'unavailable'; reason: 'snapshot_v1' }
  textProfile: {
    overrides: {
      role: string
      field: string
      value: string | number
      status: 'confirmed' | 'provisional'
      assignedBy: 'model' | 'user'
    }[]
  }
  grammar: { promoted: false }
  fidelity: { structural: 'expand' | 'merge' | 'strict' }
  template:
    | null
    | (NonNullable<ProfileMachine['template']> & {
        derivationSchema:
          | 'report-style-derivation/1'
          | 'report-style-derivation/2'
        styleSourcesSha256: string
      })
}

const validate: Ajv.ValidateFunction = reportStyleValidators.profileV2
const headings = new Set([
  'DOCUMENT_TITLE',
  'SECTION_HEADING',
  'SUBSECTION_HEADING',
  'ITEM_HEADING',
])
const fixedRoles = new Set<string>(['DOCUMENT_TITLE', 'SECTION_HEADING', 'SUBSECTION_HEADING', 'ITEM_HEADING', 'BODY_PARAGRAPH', 'BULLET_ITEM', 'CAPTION', 'TABLE_HEADER', 'TABLE_VALUE', 'NOTE_PARAGRAPH', 'FOOTNOTE', 'SIGNATURE', 'COVER', 'EMPTY_SPACER'])
const customRole = /^X-[A-Z][A-Z0-9_]{0,23}$/

export function styleSources(styles: RoleStyleVariant[]) {
  const byPair = new Map<
    string,
    { marker: string; representativeRef: string }
  >()
  for (const { marker, representativeRef } of styles) {
    const pair = { marker, representativeRef }
    byPair.set(JSON.stringify([marker, representativeRef]), pair)
  }
  return [...byPair.values()].sort((a, b) =>
    a.marker < b.marker
      ? -1
      : a.marker > b.marker
        ? 1
        : a.representativeRef < b.representativeRef
          ? -1
          : a.representativeRef > b.representativeRef
            ? 1
            : 0,
  )
}

export function derivationDigestV2(
  profile: Pick<
    ProfileV2,
    'measurementSha256' | 'roleStyleMap' | 'fixedRegions'
  >,
) {
  return canonicalDigest({
    schema: 'report-style-derivation/2',
    measurementSha256: profile.measurementSha256,
    styleSources: styleSources(profile.roleStyleMap),
    fixedRegions: profile.fixedRegions,
  })
}

/** Only the snapshot-v1 upgrade is supported here; v2 extraction has a separate contract. */
export async function upgradeSnapshotV1(input: unknown): Promise<{
  profile: ProfileV2
  invalidatedTemplate: ProfileMachine['template']
}> {
  const old = validateStyleJson<ProfileMachine>('profile', input)
  if (canonicalDigest(old.snapshot) !== old.measurementSha256)
    throw new Error('Measurement digest mismatch.')
  const { bindings, template, schema: _schema, ...common } = old
  const roleStyleMap: RoleStyleVariant[] = bindings.map(
    ({ key, assignedBy, marker, representativeRef }) => ({
      role: null,
      variant: null,
      marker,
      representativeRef,
      context: {},
      preferred: false,
      assignedBy: 'migrated',
      legacy: { key, assignedBy },
    }),
  )
  const styleSourcesSha256 = canonicalDigest(styleSources(roleStyleMap))
  const keep =
    template &&
    template.derivedFromSourceSha256 === old.snapshot.source.sha256 &&
    template.derivationSha256 === (await derivationDigest(old))
  const unavailable = { state: 'unavailable', reason: 'snapshot_v1' } as const
  const profile: ProfileV2 = {
    ...common,
    schema: 'report-style-profile/2',
    analysis: unavailable,
    analysisSha256: null,
    semantics: [],
    semanticsSha256: canonicalDigest([]),
    roleStyleMap,
    stats: unavailable,
    textProfile: { overrides: [] },
    grammar: { promoted: false },
    fidelity: { structural: 'expand' },
    template: keep
      ? {
          ...template,
          derivationSchema: 'report-style-derivation/1',
          styleSourcesSha256,
        }
      : null,
  }
  return {
    profile: await validateProfileV2(profile),
    invalidatedTemplate: template && !keep ? template : null,
  }
}

/** Validate all digests and refs, including the legacy template's original input. */
export async function validateProfileV2(input: unknown): Promise<ProfileV2> {
  return validateProfileV2Internal(input, false)
}

export async function validateExpandedProfileV2(input: unknown): Promise<ProfileV2> {
  return validateProfileV2Internal(input, true)
}

async function validateProfileV2Internal(input: unknown, expanded: boolean): Promise<ProfileV2> {
  const value = copyJson(input, {
    maxBytes: (expanded ? 84 : 32) * 1024 * 1024,
    maxDepth: 32,
    // Snapshot and evidence retain their independent byte and schema limits.
    maxNodes: expanded ? 3000000 : 1500000,
  })
  if (
    new TextEncoder().encode(JSON.stringify(value)).byteLength >
      (expanded ? 21 : 5) * 1024 * 1024 ||
    !validate(value)
  )
    throw new Error(`Invalid v2 profile: ${JSON.stringify(validate.errors)}`)
  const profile = value as unknown as ProfileV2
  // Reuse the v1 snapshot and fixed-region invariants without trusting legacy keys.
  const {
    analysis: _analysis,
    analysisSha256: _analysisSha256,
    semanticReplay: _semanticReplay,
    semantics: _semantics,
    semanticsSha256: _semanticsSha256,
    roleStyleMap,
    stats: _stats,
    textProfile: _textProfile,
    grammar: _grammar,
    fidelity: _fidelity,
    ...common
  } = profile
  const legacyProfile = {
    ...common,
    schema: 'report-style-profile/1',
    template: null,
    bindings: roleStyleMap.map((style, index) => ({
      key: `v2-${index}`,
      marker: style.marker,
      representativeRef: style.representativeRef,
      assignedBy: 'model',
    })),
  }
  if (expanded) {
    if (profile.semanticReplay && new TextEncoder().encode(JSON.stringify(profile.semanticReplay.evidence)).byteLength > 4 * 1024 * 1024)
      throw new Error('Semantic evidence exceeds 4 MiB.')
    await validateOwnedExpandedProfile(legacyProfile)
  } else validateStyleJson<ProfileMachine>('profile', legacyProfile)
  if (!expanded && canonicalDigest(profile.snapshot) !== profile.measurementSha256)
    throw new Error('Measurement digest mismatch.')
  if (profile.semanticReplay &&
    (canonicalDigest(profile.semanticReplay.evidence) !== profile.semanticReplay.evidenceSha256 ||
      !validReplayBinding(profile.snapshot, profile.measurementSha256, profile.semanticReplay)))
    throw new Error('Semantic replay digest or measurement mismatch.')
  if (canonicalDigest(profile.semantics) !== profile.semanticsSha256)
    throw new Error('Semantic digest mismatch.')
  validateAssignments(profile)
  const allRoles = [
    ...profile.semantics.map((item) => item.role),
    ...roleStyleMap.flatMap((item) => [item.role, item.context.parentRole]),
    ...profile.textProfile.overrides.map((item) => item.role),
  ].filter((role): role is string => role != null)
  if (
    allRoles.some((role) => !fixedRoles.has(role) && !customRole.test(role)) ||
    new Set(allRoles.filter((role) => customRole.test(role))).size > 16
  )
    throw new Error('Invalid structural role vocabulary.')
  for (const style of roleStyleMap) {
    if (style.variant !== null && !/^[\p{L}\p{N}]{1,12}$/u.test(style.variant))
      throw new Error('Invalid variant name.')
    const named = parseVariantMarker(style.marker)
    if (style.variant !== null ? named?.variant !== style.variant : named !== null && style.assignedBy !== 'migrated')
      throw new Error('Variant name and supported marker must match.')
    if (style.role === null && style.assignedBy !== 'migrated')
      throw new Error('Invalid migrated style provenance.')
  }
  if (profile.template) {
    const template = profile.template
    // V1 derivation was verified at upgrade; legacy labels are display-only.
    const expected = template.derivationSchema === 'report-style-derivation/2'
      ? derivationDigestV2(profile)
      : template.derivationSha256
    if (
      template.derivedFromSourceSha256 !== profile.snapshot.source.sha256 ||
      template.styleSourcesSha256 !==
        canonicalDigest(styleSources(roleStyleMap)) ||
      template.derivationSha256 !== expected
    )
      throw new Error('Template derivation mismatch.')
  }
  return profile
}

function validateAssignments(profile: ProfileV2): void {
  const positions = new Map(
    profile.snapshot.paragraphs.map((paragraph, index) => [
      paragraph.ref,
      index,
    ]),
  )
  const seen = new Set<string>()
  for (const item of profile.semantics) {
    const position = positions.get(item.ref)
    const parentPosition = item.semanticParentRef == null ? undefined : positions.get(item.semanticParentRef)
    if (
      position === undefined ||
      seen.has(item.ref) ||
      (headings.has(item.role)
        ? typeof item.level !== 'number' || !Number.isInteger(item.level) || item.level < 1 || item.level > 9
        : item.level !== undefined) ||
      (item.semanticParentRef != null &&
        (parentPosition === undefined || parentPosition >= position))
    )
      throw new Error('Invalid semantic assignment.')
    seen.add(item.ref)
  }
}

/** Model provenance is supplied by the host, never by the incoming payload. */
export async function setModelSemantics(
  profile: ProfileV2,
  input: Omit<SemanticAssignment, 'assignedBy'>[],
): Promise<ProfileV2> {
  if (
    input.length > 256 ||
    input.some((item) =>
      Object.prototype.hasOwnProperty.call(item, 'assignedBy'),
    )
  )
    throw new Error('Invalid semantic assignment input.')
  const merged = new Map(profile.semantics.map((item) => [item.ref, item]))
  const seen = new Set<string>()
  for (const item of input) {
    if (seen.has(item.ref)) throw new Error('Duplicate semantic assignment.')
    seen.add(item.ref)
    merged.set(item.ref, { ...item, assignedBy: 'model' })
  }
  const order = new Map(
    profile.snapshot.paragraphs.map((paragraph, index) => [
      paragraph.ref,
      index,
    ]),
  )
  const semantics = [...merged.values()].sort(
    (a, b) => (order.get(a.ref) ?? Infinity) - (order.get(b.ref) ?? Infinity),
  )
  return validateProfileV2({
    ...profile,
    semantics,
    semanticsSha256: canonicalDigest(semantics),
  })
}
