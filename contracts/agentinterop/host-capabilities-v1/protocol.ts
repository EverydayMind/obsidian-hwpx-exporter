/**
 * Host capabilities v1: optional host-only members of an agentinterop v1/v2
 * provider object. None of them is a model tool. The descriptor returned by
 * describe() is unchanged. See README.md for limits and host behavior.
 */

/**
 * Optional tool `_meta` key (section 7 of README.md). Up to 8 unique strings,
 * each ^[a-z][a-z0-9_-]{0,31}$: fenced code block languages the tool works on
 * in Markdown notes. An exposure hint only, not approval, permit or privacy.
 * Emit it only when the host advertisement lists 'host-capabilities-v1'; an
 * older host rejects the whole descriptor. Covered by the approval digest.
 */
export const META_CODE_BLOCK_LANGUAGES = 'dev.agentinterop/codeBlockLanguages'

/**
 * Optional provider member (section 8 of README.md): a synchronous, hide-only
 * list of the provider's own tools that cannot work right now. Emit it only
 * when the host advertisement lists 'host-capabilities-v1'. Never part of the
 * approval digest.
 */
export const MEMBER_TOOL_AVAILABILITY = 'toolAvailability'

/** `name` is a tool name from the provider's own descriptor. */
export type ToolAvailabilityEntry = {
  name: string
  /** Plain text for people in the user's locale; the host trims it to 200 units. */
  reason: string
}

export type ToolAvailability = {
  version: 1
  /** At most 64 entries. A tool not listed is available. */
  unavailable: ToolAvailabilityEntry[]
}

export type SkillLocale = 'ko' | 'en'

/** SKILL.md frontmatter as data. Limits: assets.schema.json. */
export type SkillAssetFrontmatter = {
  // Translated fields: may differ between locale variants of one id.
  name: string
  description: string
  trigger_keywords?: string[]
  // Switch fields: must be identical across locale variants of one id.
  applies_to?: string[]
  tools?: string[]
  'allowed-tools'?: string[]
  'preferred-tools'?: string[]
  'required-plugins'?: string[]
  'requires-host-tools'?: string[]
  workflow?: string
  standalone?: boolean
  cross_document?: boolean
  'disable-model-invocation'?: boolean
}

export type SkillAsset = {
  /** Stable slug inside the plugin. Host id is `${pluginId}:${id}`. */
  id: string
  locale: SkillLocale
  frontmatter: SkillAssetFrontmatter
  /** SHA-256 (lowercase hex) of the UTF-8 bytes of the body readAsset returns. */
  bodySha256: string
  /** cl100k_base token count of the body (js-tiktoken), 1..5000. */
  bodyTokens: number
}

export type AssetsDescriptor = {
  /** 1 for this contract. An unknown integer means "ignore the member", not a defect. */
  version: 1
  skills: SkillAsset[]
}

/** On the host plugin instance under Symbol.for('dev.agentinterop.host'). */
export type HostAdvertisement = {
  protocol: 'agentinterop'
  /** Includes 'host-capabilities-v1' when the host knows this contract. */
  contracts: string[]
  hostVersion: string
}

export type ReadAssetRequest = {
  kind: 'skill'
  id: string
  locale: SkillLocale
}
export type ReadAssetResult = { body: string }

export type ExtractTextInput = {
  path: string
  signal: AbortSignal
  ocr: 'off' | 'candidates'
  maxChars: number
}

/** Limits mirror src/core/rag/documentSources/kordocIndexText.ts (zod). */
export type ExtractTextChunk = {
  /** <= 200 chars */
  id: string
  type: 'heading' | 'text' | 'table'
  /** <= 2,000,000 chars; the sum over all chunks <= maxChars */
  text: string
  /** <= 100 items, each <= 2,000 chars */
  breadcrumb: string[]
  /** positive integers */
  page?: number
  pageEnd?: number
  /** non-negative integers, [1] >= [0] */
  blockRange: [number, number]
}

export type ExtractTextQuality = {
  needsOcr?: boolean
  /** positive integers */
  ocrCandidatePages: number[]
  /** non-negative integer */
  lowTextPageCount?: number
}

export type ExtractorVersion = {
  /** Provider-chosen, ^[a-z0-9-]{1,64}$. KorDoc Transform keeps 'kordoc'. */
  id: string
  engineVersion: string
  chunkerVersion: string
}

/**
 * Same shape and limits as KorDoc Transform `api.indexText` v1, except that
 * `extractor.id` is provider-chosen. Unknown extra keys are ignored. A key
 * whose value is `undefined` makes the whole result invalid: omit the key.
 */
export type ExtractTextResult =
  | {
      status: 'ok'
      format: string
      /** ^[a-f0-9]{64}$ */
      sourceSha256: string
      /** size >= 0 */
      sourceStamp: { mtime: number; size: number }
      /** Must equal extractText.extractorVersion (plus ocrApplied). */
      extractor: ExtractorVersion & { ocrApplied?: boolean }
      pageMode?: 'layout' | 'section' | null
      quality?: ExtractTextQuality
      pageCount: number | null
      outline: { level: number; text: string }[]
      /** <= 100,000 chunks */
      chunks: ExtractTextChunk[]
      truncated: boolean
      /** count: positive integer */
      warnings: { code: string; count: number }[]
    }
  | {
      status:
        | 'encrypted'
        | 'drm'
        | 'unsupported'
        | 'corrupted'
        | 'too_large'
        | 'empty'
        | 'bomb'
        | 'needs_ocr'
      message?: string
      pageCount?: number
      quality?: ExtractTextQuality
    }

export type HostCapabilityMembers = {
  /** Called concurrently with describe(); 1,000 ms. A getter rejects the provider. */
  describeAssets?(): AssetsDescriptor | Promise<AssetsDescriptor>
  /** Injection: active providers only. Display: also pending/reapproval. 1,000 ms. */
  readAsset?(
    request: ReadAssetRequest,
  ): ReadAssetResult | Promise<ReadAssetResult>
  /** Active providers only; 30 s deadline; no busy lock. */
  extractText?: {
    version: 1
    /** v1: a non-empty, duplicate-free subset of '.hwp', '.hwpx', '.pdf'. */
    extensions: string[]
    /** Read before extract(); decides whether stored projections are stale. */
    extractorVersion: ExtractorVersion
    extract(input: ExtractTextInput): Promise<ExtractTextResult>
  }
  /**
   * Read regardless of approval, through a reader separate from the
   * descriptor path. Synchronous; anything but `false` blocks.
   */
  privacy?: {
    isBlocked(path: string): boolean
    /** Required. Lowercase with the dot, 1..32 entries, compared case-insensitively. */
    extensions: string[]
  }
  /**
   * Companion (non-session) windows only. 2,000 ms, <= 100 paths, each <= 4,096
   * chars. Failure, or a declaring provider that is not active, is never an
   * empty list: ownership becomes unverifiable and writes are refused.
   */
  ownership?: {
    openDocumentPaths(): Promise<string[]>
  }
  /**
   * Own data property function, never a getter. Synchronous, no I/O, must not
   * throw. A malformed result means "all tools available". Hide-only.
   */
  toolAvailability?(): ToolAvailability
}
