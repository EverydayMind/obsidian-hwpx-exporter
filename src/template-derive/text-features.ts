/** Text-free, versioned features shared with the HWPX Exporter. */
export const TEXT_FEATURES_VERSION = 'ko-text-features/0.1'
export const PREFIX_SYMBOLS = [
  '□',
  '■',
  '○',
  '●',
  '◦',
  'ㅇ',
  '•',
  '※',
  '▶',
  '▷',
  '▪',
  '◆',
  '◇',
  'ㆍ',
  '–',
  '—',
  '―',
  '-',
  '*',
] as const
type PrefixClass =
  | 'ROMAN_UPPER'
  | 'ROMAN_LOWER'
  | 'ARABIC_DOT'
  | 'ARABIC_PAREN'
  | 'ARABIC_BOTH_PAREN'
  | 'KOREAN_DOT'
  | 'KOREAN_PAREN'
  | 'KOREAN_BOTH_PAREN'
  | 'CIRCLED_NUMBER'
  | 'CIRCLED_KOREAN'
  | 'SYMBOL'
  | 'NONE'
type EndingClass =
  | 'declarative'
  | 'nominal'
  | 'noun_phrase'
  | 'polite'
  | 'question'
  | 'other'
  | 'empty'
type PatternClass =
  | 'CAPTION_LABEL'
  | 'REFERENCE_LEAD'
  | 'DATE'
  | 'ORG_SUFFIX'
  | 'PAGE_NUMBER'
export type TextFeatures = {
  eojeolCount: number
  sentenceCount: number
  endingClass: EndingClass
  endingRule: string
  finalPeriod: boolean
  prefixClass: PrefixClass
  prefixRank: number | null
  prefixSymbol: string | null
  textPatterns: Array<{ class: PatternClass; rule: string }>
  numericShare: number
  empty: boolean
}

type Prefix = {
  kind: PrefixClass
  rank: number | null
  symbol: string | null
  rest: string
}
function prefixOf(value: string): Prefix {
  const text = value.trimStart()
  const rules: Array<[RegExp, PrefixClass, number]> = [
    [/^(?:[Ⅰ-Ⅻ]+[.)]?|[IVXLCDM]+[.)])\s*/u, 'ROMAN_UPPER', 1],
    [/^(?:[ⅰ-ⅻ]+[.)]?|[ivxlcdm]+[.)])\s*/u, 'ROMAN_LOWER', 1],
    [/^\p{Nd}{1,3}[.．](?!\p{Nd})\s*/u, 'ARABIC_DOT', 2],
    [/^[가나다라마바사아자차카타파하][.．]\s*/u, 'KOREAN_DOT', 3],
    [/^\p{Nd}{1,3}[)）]\s*/u, 'ARABIC_PAREN', 4],
    [/^[가나다라마바사아자차카타파하][)）]\s*/u, 'KOREAN_PAREN', 5],
    [/^[(（]\p{Nd}{1,3}[)）]\s*/u, 'ARABIC_BOTH_PAREN', 6],
    [/^[(（][가나다라마바사아자차카타파하][)）]\s*/u, 'KOREAN_BOTH_PAREN', 7],
    [/^[①-⑳㉑-㉟㊱-㊿]\s*/u, 'CIRCLED_NUMBER', 8],
    [/^[㉮-㉻]\s*/u, 'CIRCLED_KOREAN', 9],
    [/^[□■○●◦ㅇ•※▶▷▪◆◇ㆍ–—―*-]\s*/u, 'SYMBOL', 10],
  ]
  for (const [pattern, kind, rank] of rules) {
    const match = pattern.exec(text)
    if (match)
      return {
        kind,
        rank,
        symbol: kind === 'SYMBOL' ? [...match[0]][0] : null,
        rest: text.slice(match[0].length),
      }
  }
  return { kind: 'NONE', rank: null, symbol: null, rest: text }
}

function endingOf(
  content: string,
  words: number,
): { endingClass: EndingClass; endingRule: string } {
  if (!content) return { endingClass: 'empty', endingRule: 'empty' }
  const clean = content.replace(/[.．!?。！？]+$/u, '').trim()
  if (!clean) return { endingClass: 'other', endingRule: 'punctuation_only' }
  if (/[?？]$/u.test(content) || /(?:습니까|나요|까요)$/u.test(clean))
    return { endingClass: 'question', endingRule: 'question' }
  if (/(?:습니다|[가-힣]니다|세요|십시오|해요)$/u.test(clean))
    return { endingClass: 'polite', endingRule: 'polite_suffix' }
  if (
    /(?:한다|된다|있다|없다|했다|였다|이다|하다|같다|않다|됐다)$/u.test(
      clean,
    ) ||
    (words >= 2 && /다$/u.test(clean))
  )
    return { endingClass: 'declarative', endingRule: 'declarative_suffix' }
  if (words >= 4 && /(?:은|는|이|가|을|를|으로|에서)(?:\s|$)/u.test(clean))
    return { endingClass: 'declarative', endingRule: 'particle_sentence' }
  if (/(?:함|됨|임)$/u.test(clean))
    return { endingClass: 'nominal', endingRule: 'nominal_suffix' }
  if (words <= 4 && !/[.．!?。！？]$/u.test(content))
    return { endingClass: 'noun_phrase', endingRule: 'short_phrase' }
  return { endingClass: 'other', endingRule: 'other' }
}

function countSentences(content: string): number {
  if (!content) return 0
  // Do not count the separators inside a spaced Korean date as sentences.
  const normalized = content
    .replace(/^(?:<|\[)?(?:표|그림|사진|도표|그래프)\s*\p{Nd}+[.．]\s*/u, '')
    .replace(
      /(\p{Nd}{4})\s*[.．]\s*(\p{Nd}{1,2})\s*[.．]\s*(\p{Nd}{1,2})(?=\s|[.．]|$)/gu,
      '$1-$2-$3',
    )
  let count = 0
  let lastEnd = 0
  for (const match of normalized.matchAll(/[.．!?。！？]+/gu)) {
    const start = match.index,
      end = start + match[0].length
    const before =
      [...normalized.slice(Math.max(0, start - 2), start)].at(-1) ?? ''
    const after =
      end < normalized.length
        ? String.fromCodePoint(normalized.codePointAt(end)!)
        : ''
    if (
      (match[0] === '.' || match[0] === '．') &&
      /\p{Nd}/u.test(before) &&
      /\p{Nd}/u.test(after)
    )
      continue
    if (
      end === normalized.length ||
      /\s|[)\]）】]/u.test(normalized[end] ?? '')
    ) {
      count++
      lastEnd = end
    }
  }
  if (count && normalized.slice(lastEnd).replace(/^[\s"'”’\])）】]+/u, ''))
    count++
  return Math.max(1, count)
}

/** Deliberately coarse heuristics: output is classification evidence, never source text. */
export function textFeatures(value: string): TextFeatures {
  if (typeof value !== 'string' || value.length > 16 * 1024 * 1024)
    throw new RangeError('Text feature input exceeds limit.')
  const prefix = prefixOf(value),
    content = prefix.rest.trim()
  let all = 0,
    numeric = 0,
    words = 0,
    inWord = false,
    previous = ''
  for (let offset = 0; offset < content.length; ) {
    const point = String.fromCodePoint(content.codePointAt(offset)!)
    const nextOffset = offset + point.length
    const next =
      nextOffset < content.length
        ? String.fromCodePoint(content.codePointAt(nextOffset)!)
        : ''
    if (/\s/u.test(point)) inWord = false
    else {
      if (!inWord) words++
      inWord = true
      all++
      if (
        /\p{N}/u.test(point) ||
        (/[.．,，+\-−/%％₩$€¥:]/u.test(point) &&
          (/\p{N}/u.test(previous) || /\p{N}/u.test(next)))
      )
        numeric++
    }
    previous = point
    offset = nextOffset
  }
  if (all > 8 * 1024 * 1024)
    throw new RangeError('Text feature input exceeds limit.')
  const patterns: TextFeatures['textPatterns'] = []
  if (/^(?:<|\[)?(?:표|그림|사진|도표|그래프)\s*\p{Nd}/u.test(content))
    patterns.push({ class: 'CAPTION_LABEL', rule: 'caption_label' })
  if (/^(?:붙임|별첨|참고)(?:\s*\p{Nd}|\s*[:：])/u.test(content))
    patterns.push({ class: 'REFERENCE_LEAD', rule: 'reference_lead' })
  if (
    /^\p{Nd}{4}\s*(?:년|[.．\-/])\s*\p{Nd}{1,2}\s*(?:월|[.．\-/])\s*\p{Nd}{1,2}\s*(?:일|[.．])?$/u.test(
      content,
    )
  )
    patterns.push({ class: 'DATE', rule: 'date_line' })
  if (
    /(?:부|처|청|원|위원회|공단|공사|재단|센터)\s*(?:장관|위원장)?$/u.test(
      content,
    )
  )
    patterns.push({ class: 'ORG_SUFFIX', rule: 'organization_suffix' })
  if (/^\s*[-–—]\s*\p{Nd}+\s*[-–—]\s*$/u.test(value))
    patterns.push({ class: 'PAGE_NUMBER', rule: 'page_number' })
  return {
    eojeolCount: words,
    sentenceCount: countSentences(content),
    ...endingOf(content, words),
    finalPeriod: /[.．。]$/u.test(content),
    prefixClass: prefix.kind,
    prefixRank: prefix.rank,
    prefixSymbol: prefix.symbol,
    textPatterns: patterns,
    numericShare: all ? Math.round((numeric / all) * 1000) / 1000 : 0,
    empty: !value.trim(),
  }
}

/** Called after fixed-vocabulary schema validation to bind counts and rule pairs. */
export function validTextFeatureBinding(
  features: TextFeatures,
  length: number,
  rawNonempty: boolean,
): boolean {
  const ranks: Record<PrefixClass, number | null> = {
    NONE: null,
    ROMAN_UPPER: 1,
    ROMAN_LOWER: 1,
    ARABIC_DOT: 2,
    KOREAN_DOT: 3,
    ARABIC_PAREN: 4,
    KOREAN_PAREN: 5,
    ARABIC_BOTH_PAREN: 6,
    KOREAN_BOTH_PAREN: 7,
    CIRCLED_NUMBER: 8,
    CIRCLED_KOREAN: 9,
    SYMBOL: 10,
  }
  const endingRules: Record<string, EndingClass> = {
    empty: 'empty',
    punctuation_only: 'other',
    question: 'question',
    polite_suffix: 'polite',
    declarative_suffix: 'declarative',
    particle_sentence: 'declarative',
    nominal_suffix: 'nominal',
    short_phrase: 'noun_phrase',
    other: 'other',
  }
  const patternRules = [
    'caption_label',
    'reference_lead',
    'date_line',
    'organization_suffix',
    'page_number',
  ]
  const patternClasses: PatternClass[] = [
    'CAPTION_LABEL',
    'REFERENCE_LEAD',
    'DATE',
    'ORG_SUFFIX',
    'PAGE_NUMBER',
  ]
  return (
    features.empty === !rawNonempty &&
    (rawNonempty ||
      (features.prefixClass === 'NONE' &&
        features.numericShare === 0 &&
        features.textPatterns.length === 0)) &&
    features.eojeolCount <= length &&
    features.sentenceCount <= length &&
    (features.eojeolCount === 0
      ? features.sentenceCount === 0 &&
        features.endingClass === 'empty' &&
        !features.finalPeriod
      : features.sentenceCount > 0 && features.endingClass !== 'empty') &&
    features.prefixRank === ranks[features.prefixClass] &&
    (features.prefixClass === 'SYMBOL'
      ? features.prefixSymbol !== null &&
        PREFIX_SYMBOLS.includes(
          features.prefixSymbol as (typeof PREFIX_SYMBOLS)[number],
        )
      : features.prefixSymbol === null) &&
    endingRules[features.endingRule] === features.endingClass &&
    features.textPatterns.every(
      (pattern, i) =>
        patternClasses[patternRules.indexOf(pattern.rule)] === pattern.class &&
        (i === 0 ||
          patternRules.indexOf(pattern.rule) >
            patternRules.indexOf(features.textPatterns[i - 1].rule)),
    )
  )
}
