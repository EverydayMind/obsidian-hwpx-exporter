import { type ScriptState, scriptSpanBound } from './scriptRuns'
import {
  type SemanticSpan,
  measuredContainer,
  validSemanticSpans,
} from './semanticSpans'
import { type TextFeatures, validTextFeatureBinding } from './text-features'
import type { StyleSnapshot } from './types'

export type AutomaticMarker =
  | { state: 'none' }
  | {
      state: 'unavailable'
      reason:
        | 'unsupported_format'
        | 'unresolved_reference'
        | 'unsupported_definition'
    }
  | {
      state: 'measured'
      kind: 'number' | 'bullet'
      level: number
      format: 'digit' | 'hangul' | 'roman' | 'latin' | 'bullet' | 'other'
      series?: string
    }

// Shape and fixed vocabularies are checked by the containing profile schema.
export type SemanticReplay = {
  evidence: {
    schema:
      | 'report-style-semantic-evidence/0.1'
      | 'report-style-semantic-evidence/0.2'
      | 'report-style-semantic-evidence/0.3'
      | 'report-style-semantic-evidence/0.4'
      | 'report-style-semantic-evidence/0.5'
      | 'report-style-semantic-evidence/0.6'
      | 'report-style-semantic-evidence/0.7'
      | 'report-style-semantic-evidence/0.8'
    ruleSetVersion:
      | 'ko-structure/0.4'
      | 'ko-structure/0.5'
      | 'ko-structure/0.6'
      | 'ko-structure/0.7'
      | 'ko-structure/0.8'
      | 'ko-structure/0.9'
      | 'ko-structure/0.10'
    textFeaturesVersion?: 'ko-text-features/0.1'
    measurementSha256: string
    pageNumberControls?: Record<
      string,
      | { state: 'present'; count: number }
      | { state: 'absent'; count: 0 }
      | { state: 'unknown'; count: null }
    >
    nodes: {
      ref: string
      textLength: number
      rawNonempty: boolean
      contentNonempty: boolean
      prefix: string
      prefixRank: number | null
      prefixBullet: boolean
      ending: string
      wordCount: number
      caption: boolean
      note: boolean
      titleTerm: boolean
      notice: boolean
      organization: boolean
      dateRaw: boolean
      dateContent: boolean
      discourse: { role: string; evidence: string }[]
      spans: SemanticSpan[]
      spanCoverage: 'complete' | 'partial'
      textFeatures?: TextFeatures
      automaticMarker?: AutomaticMarker
      scriptRuns?: ScriptState[]
    }[]
  }
  evidenceSha256: string
}

export function validReplayBinding(
  snapshot: StyleSnapshot,
  measurement: string,
  replay: SemanticReplay,
): boolean {
  const evidence = replay.evidence
  if (
    evidence.measurementSha256 !== measurement ||
    evidence.nodes.length !== snapshot.paragraphs.length
  )
    return false
  if (evidence.pageNumberControls) {
    const sections = snapshot.sections.map((section) => section.ref)
    const keys = Object.keys(evidence.pageNumberControls)
    if (
      keys.length !== sections.length ||
      sections.some(
        (ref) =>
          !Object.prototype.hasOwnProperty.call(
            evidence.pageNumberControls,
            ref,
          ),
      ) ||
      (snapshot.source.format === 'hwp5' &&
        keys.some(
          (ref) => evidence.pageNumberControls?.[ref]?.state !== 'unknown',
        ))
    )
      return false
  }
  const refs = new Map(snapshot.nodes.map((node) => [node.ref, node]))
  const ranks: Record<string, number | null> = {
    NONE: null,
    ROMAN: 1,
    ARABIC_DOT: 2,
    KOREAN_DOT: 3,
    ARABIC_PAREN: 4,
    KOREAN_PAREN: 5,
    BOTH_PAREN: 6,
    CIRCLED: 7,
    SYMBOL: 8,
  }
  const discourseOrder = [
    'BACKGROUND',
    'STATUS',
    'PROBLEM',
    'OBJECTIVE',
    'ACTION',
    'EFFECT',
    'SUMMARY',
  ]
  const seriesKinds = new Map<string, string>()
  return evidence.nodes.every((node, index) => {
    const paragraph = snapshot.paragraphs[index]
    const marker = node.automaticMarker
    if (marker?.state === 'measured' && marker.series) {
      const prior = seriesKinds.get(marker.series)
      if (prior && prior !== marker.kind) return false
      seriesKinds.set(marker.series, marker.kind)
    }
    return (
      node.ref === paragraph.ref &&
      node.textLength === paragraph.textCodePoints &&
      node.prefixRank === ranks[node.prefix] &&
      node.wordCount <= node.textLength &&
      (!node.automaticMarker ||
        (snapshot.source.format === 'hwp5' &&
        !['ko-structure/0.9', 'ko-structure/0.10'].includes(
          evidence.ruleSetVersion,
        )
          ? node.automaticMarker.state === 'unavailable' &&
            node.automaticMarker.reason === 'unsupported_format'
          : node.automaticMarker.state !== 'unavailable' ||
            node.automaticMarker.reason !== 'unsupported_format')) &&
      (!node.scriptRuns || node.scriptRuns.length === paragraph.runs.length) &&
      node.spans.every((span) =>
        span.shape !== 'superscript' && span.shape !== 'subscript'
          ? true
          : !!node.scriptRuns &&
            scriptSpanBound(paragraph.runs, node.scriptRuns, span),
      ) &&
      (!node.textFeatures ||
        validTextFeatureBinding(
          node.textFeatures,
          node.textLength,
          node.rawNonempty,
        )) &&
      !(
        !node.rawNonempty &&
        (node.contentNonempty ||
          node.prefix !== 'NONE' ||
          node.note ||
          node.dateRaw ||
          node.spans.length > 0)
      ) &&
      !(
        !node.contentNonempty &&
        (node.wordCount !== 0 ||
          node.ending !== 'empty' ||
          node.caption ||
          node.titleTerm ||
          node.notice ||
          node.organization ||
          node.dateContent ||
          node.discourse.length > 0)
      ) &&
      (!node.contentNonempty || node.wordCount > 0) &&
      (node.prefix !== 'CIRCLED' || node.prefixBullet) &&
      (['CIRCLED', 'SYMBOL'].includes(node.prefix) || !node.prefixBullet) &&
      node.discourse.every(
        (item, i) =>
          i === 0 ||
          discourseOrder.indexOf(item.role) >
            discourseOrder.indexOf(node.discourse[i - 1].role),
      ) &&
      (node.spanCoverage !== 'partial' || node.spans.length === 32) &&
      validSemanticSpans(
        node.spans,
        node.textLength,
        measuredContainer(paragraph, refs),
      )
    )
  })
}
