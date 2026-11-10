/**
 * Template inspector: which markers a template defines, which look like typos,
 * and what falls back to a default because its marker is missing. It loads the
 * template exactly as a conversion would (MarkdownToHwpx with an empty
 * document), so what it reports is what the converter will do.
 */

import { MarkdownToHwpx } from './markdownToHwpx';
import type { ConversionWarning } from './conversionReport';
import { invalidStyleVariantMarkers, invalidStyleVariantSuggestion, parseMarkerOptions } from './templateMarkers';

export interface TemplateInspection {
    /** Markers the converter recognized, with the style ids they resolve to. */
    markers: ReturnType<MarkdownToHwpx['describeTemplateRules']>;
    /** `{{…}}` texts the converter does not read, with the closest known marker. */
    unknownMarkers: Array<{ marker: string; suggestion: string | null }>;
    /** Elements without a marker and how they render instead. */
    fallbacks: Array<{ marker: string; behavior: string }>;
    /** Problems found while loading the template (duplicates, ignored prefix markers). */
    warnings: ConversionWarning[];
}

const FIXED_MARKERS = [
    ...Array.from({ length: 9 }, (_, i) => `H${i + 1}`),
    'BODY', 'CODE', 'CODE_INLINE', 'LINK', 'HR',
    'QUOTE', 'QUOTE_INFO', 'QUOTE_WARN', 'QUOTE_SUCCESS', 'QUOTE_DANGER',
    'STRONG', 'EMPH', 'STRIKE', 'UNDERLINE', 'HIGHLIGHT', 'FOOTNOTE', 'CALLOUT_TITLE', 'CONTENT', 'TABLE',
    'FIGURE', 'CAPTION', 'TABLE_CAPTION', 'CODE_LANG', 'MATH', 'MATH_INLINE', 'TASK_OPEN', 'TASK_DONE',
    'CELL_STUB', 'CELL_ODD', 'CELL_EVEN', 'CELL_NUMBER',
    ...['BULLET', 'ORDERED'].flatMap((kind) => Array.from({ length: 7 }, (_, i) => `LIST_${kind}_${i + 1}`)),
    'CELL_BODY',
    ...['HEADER', 'TOP', 'MIDDLE', 'BOTTOM'].flatMap((row) => ['LEFT', 'CENTER', 'RIGHT'].map((col) => `CELL_${row}_${col}`)),
];

// Obsidian's built-in callout types (and aliases); {{CALLOUT_<TYPE>}} for any other name is likely a typo.
const CALLOUT_TYPES = [
    'NOTE', 'ABSTRACT', 'SUMMARY', 'TLDR', 'INFO', 'TODO', 'TIP', 'HINT', 'IMPORTANT', 'SUCCESS', 'CHECK',
    'DONE', 'QUESTION', 'HELP', 'FAQ', 'WARNING', 'CAUTION', 'ATTENTION', 'FAILURE', 'FAIL', 'MISSING',
    'DANGER', 'ERROR', 'BUG', 'EXAMPLE', 'QUOTE', 'CITE',
];

const FALLBACKS: Array<{ markers: string[]; behavior: string }> = [
    { markers: ['BODY'], behavior: '템플릿의 바탕글 모양으로 쓴다' },
    { markers: ['H1', 'H2', 'H3', 'H4', 'H5', 'H6'], behavior: '템플릿의 개요 스타일이 있으면 그것을, 없으면 바탕글을 쓴다' },
    { markers: ['CODE'], behavior: '코드블록을 BODY 모양으로 쓴다(박스 없음)' },
    { markers: ['CODE_INLINE', 'CODE'], behavior: '인라인 코드를 주변 글자 모양 그대로 쓴다' },
    { markers: ['LINK'], behavior: '링크를 파란 글자와 밑줄로 쓴다(설정 기본값)' },
    { markers: ['QUOTE'], behavior: '인용문을 BODY 모양에 고정 들여쓰기로 쓴다' },
    { markers: ['CALLOUT_TITLE'], behavior: '콜아웃 제목을 콜아웃 모양의 굵은 글자로 쓴다' },
    { markers: ['HR'], behavior: '수평선을 빈 문단 2개로 쓴다' },
    { markers: ['HIGHLIGHT'], behavior: '==형광==을 노란 음영으로 쓴다(설정 기본값)' },
    { markers: ['FOOTNOTE'], behavior: '각주를 템플릿의 각주 스타일(없으면 BODY)로 쓴다' },
    { markers: ['CAPTION'], behavior: '그림에 캡션 문단을 만들지 않는다' },
    { markers: ['MATH'], behavior: '$$ 수식 블록을 BODY 문단으로 쓴다' },
    { markers: ['MATH_INLINE'], behavior: '$ 인라인 수식을 주변 글자 모양 그대로 쓴다' },
    { markers: ['TASK_OPEN', 'TASK_DONE'], behavior: '할 일 상자를 [ ] / [x] 글자로 쓴다' },
    { markers: ['LIST_BULLET_1'], behavior: '글머리표 목록을 BODY 모양에 기본 글머리(ㅇ, -, ∙ …)로 쓴다' },
    { markers: ['LIST_ORDERED_1'], behavior: '번호 목록을 BODY 모양에 "1." 번호로 쓴다' },
    { markers: ['CELL_HEADER_LEFT', 'CELL_TOP_LEFT', 'CELL_BODY'], behavior: '표를 기본 표 XML로 만든다' },
];

export async function inspectTemplate(templatePath: string): Promise<TemplateInspection> {
    const { headerXml, sectionXml } = await MarkdownToHwpx.readTemplate(templatePath);
    return inspectTemplateXml(headerXml, sectionXml);
}

export function inspectTemplateXml(headerXml: string, sectionXml: string): TemplateInspection {
    const converter = new MarkdownToHwpx({ 'pandoc-api-version': [1, 23], meta: {}, blocks: [] }, headerXml, sectionXml, null, null, undefined, undefined, false, undefined, false);
    const markers = converter.describeTemplateRules();
    const recognized = new Set(markers.map((rule) => rule.marker));
    const warnings = converter.report.toJSON().warnings;
    const reported = new Set(warnings.flatMap((warning) => warning.examples));

    const unknownMarkers: TemplateInspection['unknownMarkers'] = invalidStyleVariantMarkers(sectionXml);
    const seen = new Set<string>();
    for (const match of sectionXml.matchAll(/\{\{([^{}<>\r\n]{1,40})\}\}/g)) {
        if (invalidStyleVariantSuggestion(match[0])) continue;
        // {{H1|pageBreak}} is checked as {{H1}}; its options are checked by the converter.
        const parsed = parseMarkerOptions(match[1]);
        const marker = parsed?.canonical ?? match[0];
        const name = marker.slice(2, -2);
        if (seen.has(marker) || reported.has(marker)) continue;
        seen.add(marker);
        // Obsidian allows custom callout types, so {{CALLOUT_<X>}} is accepted
        // unless X is a near miss of a built-in type (a typo).
        // {{CALLOUT_TITLE_<X>}} is the title rule of {{CALLOUT_<X>}} or {{QUOTE_<X>}}.
        if (/^CALLOUT_[\p{L}\p{N}_]+$/u.test(name) && name !== 'CALLOUT_TITLE') {
            const title = name.startsWith('CALLOUT_TITLE_');
            const type = name.slice(title ? 'CALLOUT_TITLE_'.length : 'CALLOUT_'.length);
            const known = title ? [...CALLOUT_TYPES, 'WARN'] : CALLOUT_TYPES;
            const near = /^[A-Z0-9_]+$/.test(type) && !known.includes(type)
                ? known.find((candidate) => editDistance(type, candidate) <= 2)
                : undefined;
            if (near) unknownMarkers.push({ marker, suggestion: `{{CALLOUT_${title ? 'TITLE_' : ''}${near}}}` });
            continue;
        }
        // A quote kind beyond the built-in four is reachable only through its
        // callouts=/emoji= options; without them it is most likely a typo.
        if (/^QUOTE_[A-Z0-9]+$/.test(name) && !FIXED_MARKERS.includes(name) && !parsed) {
            unknownMarkers.push({ marker, suggestion: closestMarker(name) });
            continue;
        }
        if (recognized.has(marker) || ['CONTENT', 'TABLE', 'DECOMPOSITION', 'BODY_START'].includes(name) || /^META:[^|]+(\|format=.*)?$/.test(name)) continue;
        // Prefix markers ({{□}}, {{1.}}) and numbered heading rules are reported
        // by the loader itself when they are malformed.
        if (!/^[A-Za-z_]/.test(name) || /^H[1-9]:/.test(name)) continue;
        // {{title}} is replaced in the note, not in the template.
        unknownMarkers.push({ marker, suggestion: name === 'title' ? null : closestMarker(name) });
    }

    const fallbacks = FALLBACKS
        .filter(({ markers: names }) => !names.some((name) => recognized.has(`{{${name}}}`)))
        .map(({ markers: names, behavior }) => ({ marker: names.map((name) => `{{${name}}}`).join(' / '), behavior }));

    return { markers, unknownMarkers, fallbacks, warnings };
}

function closestMarker(name: string): string | null {
    const candidates = [...FIXED_MARKERS, ...CALLOUT_TYPES.map((type) => `CALLOUT_${type}`)];
    let best: string | null = null;
    let bestDistance = Infinity;
    for (const candidate of candidates) {
        const distance = editDistance(name.toUpperCase(), candidate);
        if (distance < bestDistance) {
            best = candidate;
            bestDistance = distance;
        }
    }
    // Only near misses are worth suggesting.
    return best && bestDistance <= Math.max(2, Math.floor(best.length / 3)) ? `{{${best}}}` : null;
}

function editDistance(a: string, b: string): number {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        let previous = row[0];
        row[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const current = row[j];
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
            previous = current;
        }
    }
    return row[b.length];
}
