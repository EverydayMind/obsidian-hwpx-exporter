// Contract-only declarations. No active v1 path imports this module.
// String patterns, code-point lengths and numeric limits are schema constraints.
export const MD_DIALECT_V2 = 'hwpx-exporter-md/2' as const
export const HIERARCHY_RULES_VERSION = 'decompose-hierarchy/1' as const
export const ROLE_CATALOG_VERSION = 'role-catalog/1' as const

export type ApplicationKey =
  | `H${1 | 2 | 3 | 4 | 5 | 6}${'' | `:${string}`}`
  | `BODY${'' | `:${string}`}`
export type MarkerSeries = 'white-box' | 'black-box' | 'circled'
export type HierarchyMarker = {
  symbol: string | null
  rank: 1 | 2 | 3 | 4 | null
  series: MarkerSeries | null
  value: number | null
}
export type HierarchyJudgement = {
  ref: string
  depth: number
  parentRef: string | null
  rule: 'R0' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6'
  reason: string
  marker: HierarchyMarker
  semanticRole: string | null
  applicationKey: ApplicationKey
}
export type DecompositionFacts = {
  unifiedDifferences?: {
    key: ApplicationKey
    count: number
    representativeRef: string
  }[]
  rulesReducedByLimit?: {
    fromKey: ApplicationKey
    toKey: ApplicationKey
    count: number
  }[]
  omittedObjectSpacing?: { count: number; refs: string[] }[]
  spacingVariance?: { contextKey: string; count: number; refs: string[] }[]
  spacingContextsDropped?: { contextKey: string; count: number }[]
  sourceNumberingDiscontinuity?: {
    key: ApplicationKey
    refs: string[]
    sourceValues: (number | null)[]
  }[]
  counter_out_of_range?: {
    key: ApplicationKey
    ref: string
    series: MarkerSeries
    value: number
  }[]
  rule_limit_exceeded?: {
    nonSpaceRules: number
    bundleRules: number
    nonSpaceLimit: 14
    bundleLimit: 24
    irreducibleKeys: ApplicationKey[]
  }[]
}
export type JobFacts = {
  dialect_mismatch?: {
    markdownDialect: string
    templateDialect: string
    authority: 'record' | 'bundle'
  }[]
  dialect_unsupported?: { dialect: string }[]
  template_dialect_changed?: {
    preparedDialect: string | null
    currentDialect: string | null
  }[]
  verification_rules_version_unsupported?: {
    recordedVersion: string
    currentVersion: string
  }[]
}
export type HierarchyFacts = {
  decomposition: DecompositionFacts
  job: JobFacts
}
// Renderer report warnings are separate from decomposition and job facts.
// counter_token_split joins the active Exporter report union in P2.
export type RendererWarningCode = 'counter_out_of_range' | 'counter_token_split'
export type RendererWarningDefinition = {
  code: RendererWarningCode
  detail: string
  existing: boolean
}
export type DialectV2Versions = {
  dialect: typeof MD_DIALECT_V2
  rulesVersion: string
  catalogVersion: string
}
export type DecompositionRecordV2 = DialectV2Versions & {
  schema: 'hwpx-decomposition-record/2'
  decompositionId: string
  sourcePath: string
  sourceSha256: string
  textFile: string
  textSha256: string
  templatePayloadSha256: string
}
export type DeriveBundleV3 = DialectV2Versions & {
  schema: 'derive-bundle/3'
  sample_path: string
  expected_sample_sha256: string
  structure_sha256: string
  bindings: {
    key: string
    marker: string
    representativeRef: string
    leadingSpacerRef?: string
    prefix: string
  }[]
  fixed_regions: {
    position: 'before_content' | 'after_content'
    from_ref: string
    to_ref: string
    replacements: { paragraphRef: string; metaKey: string; format?: string }[]
  }[]
  derivation_sha256: string
}
