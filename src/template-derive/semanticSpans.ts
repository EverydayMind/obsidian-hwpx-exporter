import type { NodeRef, Paragraph } from './types'

const ruleClasses: Record<string, string> = {
  cell_leading_short_distinct_run: 'INLINE_TABLE_HEADER',
  distinct_run_not_role: 'unknown',
  unit_keyword: 'UNIT',
  reference_keyword: 'REFERENCE',
  qualifier_keyword: 'QUALIFIER',
  korean_term_latin_abbreviation: 'ABBREVIATION',
  bracket_number: 'CITATION_MARKER',
  superscript_numeric: 'CITATION_MARKER',
  script_not_role: 'unknown',
  date_in_delimiters: 'DATE_PERIOD',
  annotation_marker: 'ANNOTATION',
  unclassified_delimited: 'unknown',
}
const object = (properties: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
})

export const semanticSpanFields = {
  spanCoverage: { enum: ['complete', 'partial'] },
  spans: {
    type: 'array',
    maxItems: 32,
    items: object({
      start: { type: 'integer', minimum: 0 },
      length: { type: 'integer', minimum: 1 },
      shape: {
        enum: [
          'paren',
          'bracket',
          'angle',
          'distinct_run',
          'superscript',
          'subscript',
        ],
      },
      attaches: { enum: ['previous', 'paragraph', 'unknown'] },
      classCandidates: {
        type: 'array',
        minItems: 1,
        maxItems: 8,
        items: object({
          class: { enum: [...new Set(Object.values(ruleClasses))] },
          rule: { enum: Object.keys(ruleClasses) },
        }),
      },
    }),
  },
}

export type SemanticSpan = {
  start: number
  length: number
  shape:
    | 'paren'
    | 'bracket'
    | 'angle'
    | 'distinct_run'
    | 'superscript'
    | 'subscript'
  attaches: 'previous' | 'paragraph' | 'unknown'
  classCandidates: { class: string; rule: string }[]
}

export function measuredContainer(
  paragraph: Paragraph,
  nodes: Map<string, NodeRef>,
): string {
  const roles = paragraph.candidates.map((candidate) => candidate.role)
  let container = roles.includes('FOOTNOTE')
    ? 'footnote'
    : roles.includes('CAPTION')
      ? 'caption'
      : 'body'
  let parent = nodes.get(paragraph.ref)?.parentRef ?? null
  while (parent !== null) {
    const node = nodes.get(parent)
    if (!node) return 'invalid'
    if (node.kind === 'cell' && container === 'body') container = 'cell'
    if (node.kind === 'header' || node.kind === 'footer') return node.kind
    parent = node.parentRef
  }
  return container
}

/** Validate ranges and rule/class pairs against the measured paragraph. */
export function validSemanticSpans(
  spans: SemanticSpan[],
  total: number,
  container: unknown,
): boolean {
  const keys = new Set<string>()
  let prior: SemanticSpan | undefined
  for (const span of spans) {
    const key = `${span.start}:${span.length}:${span.shape}`
    const isScript = span.shape === 'superscript' || span.shape === 'subscript'
    if (
      !Number.isSafeInteger(span.start + span.length) ||
      span.start + span.length > total ||
      keys.has(key) ||
      (prior &&
        (span.start < prior.start ||
          (span.start === prior.start &&
            (span.length < prior.length ||
              (span.length === prior.length && span.shape < prior.shape))))) ||
      (span.shape === 'distinct_run' && container !== 'cell') ||
      (isScript &&
        !span.classCandidates.some(
          (candidate) => candidate.rule === 'script_not_role',
        )) ||
      new Set(span.classCandidates.map((candidate) => candidate.class)).size !==
        span.classCandidates.length ||
      span.classCandidates.some(
        (candidate) => ruleClasses[candidate.rule] !== candidate.class,
      ) ||
      span.classCandidates.some((candidate) =>
        isScript
          ? ![
              'script_not_role',
              ...(span.shape === 'superscript' ? ['superscript_numeric'] : []),
            ].includes(candidate.rule)
          : span.shape === 'distinct_run'
            ? ![
                'cell_leading_short_distinct_run',
                'distinct_run_not_role',
              ].includes(candidate.rule)
            : [
                'cell_leading_short_distinct_run',
                'distinct_run_not_role',
                'script_not_role',
                'superscript_numeric',
              ].includes(candidate.rule) ||
              (candidate.rule === 'bracket_number' &&
                span.shape !== 'bracket') ||
              (candidate.rule === 'korean_term_latin_abbreviation' &&
                span.shape !== 'paren'),
      ) ||
      (span.classCandidates.some(
        (candidate) => candidate.class === 'INLINE_TABLE_HEADER',
      ) &&
        (span.shape !== 'distinct_run' ||
          !span.classCandidates.some(
            (candidate) => candidate.class === 'unknown',
          )))
    )
      return false
    keys.add(key)
    prior = span
  }
  return true
}
