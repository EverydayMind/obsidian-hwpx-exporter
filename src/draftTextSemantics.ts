import { inferSpans, type SpanClass } from './draftSpans';
import type { RunEvidence } from './draftStyledRuns';
import type { Paragraph } from './template-derive/types';
import type { TextFeatures } from './template-derive/text-features';
import type { DraftScripts } from './draftScripts';

export type DraftTextSemantics = {
    prefixOrdinal: { state: 'known'; value: number } | { state: 'none' | 'unknown' };
    phrases: { scope: 'delimited_only' | 'delimited_and_cell_runs'; runCoverage: 'observed' | 'unavailable' | 'not_applicable'; truncated: boolean; candidates: Partial<Record<SpanClass, number>> };
    scripts: DraftScripts;
};

function romanValue(value: string): number | null {
    const upper = value.toUpperCase();
    if (!/^(?=.)M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/.test(upper)) return null;
    const units: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
    let total = 0;
    for (let i = 0; i < upper.length; i++) total += units[upper[i]] < (units[upper[i + 1]] ?? 0) ? -units[upper[i]] : units[upper[i]];
    return total <= 3999 ? total : null;
}

/** Only text visible in an observed paragraph; automatic numbering is separate. */
export function draftTextSemantics(text: string, features: TextFeatures, runEvidence: RunEvidence = { state: 'not_applicable' }, scripts: DraftScripts = { state: 'unavailable' }): DraftTextSemantics {
    const cls = features.prefixClass, first = text.trimStart(), normalized = first.normalize('NFKC');
    let value: number | null = null;
    if (cls.startsWith('ARABIC_')) {
        const match = /^\(?([0-9]{1,3})/.exec(normalized);
        if (match) value = Number(match[1]);
    } else if (cls === 'ROMAN_UPPER' || cls === 'ROMAN_LOWER') {
        const match = /^[IVXLCDMivxlcdm]+/.exec(normalized);
        if (match) value = romanValue(match[0]);
    } else if (cls.startsWith('KOREAN_')) {
        const match = /^\(?([가나다라마바사아자차카타파하])/.exec(normalized);
        if (match) value = '가나다라마바사아자차카타파하'.indexOf(match[1]) + 1;
    } else if (cls === 'CIRCLED_NUMBER') {
        const point = first.codePointAt(0) ?? 0;
        if (point >= 0x2460 && point <= 0x2473) value = point - 0x2460 + 1;
        else if (point >= 0x3251 && point <= 0x325f) value = point - 0x3251 + 21;
        else if (point >= 0x32b1 && point <= 0x32bf) value = point - 0x32b1 + 36;
    } else if (cls === 'CIRCLED_KOREAN') {
        const point = first.codePointAt(0) ?? 0;
        if (point >= 0x326e && point <= 0x327b) value = point - 0x326e + 1;
    }
    const result = inferSpans({ runs: runEvidence.state === 'observed' ? runEvidence.runs : [] } as unknown as Paragraph, text, runEvidence.state === 'observed');
    const candidates: Partial<Record<SpanClass, number>> = {};
    for (const span of result.spans)
        for (const candidate of span.classCandidates) candidates[candidate.class] = (candidates[candidate.class] ?? 0) + 1;
    return {
        prefixOrdinal: value !== null ? { state: 'known', value } : { state: cls === 'NONE' || cls === 'SYMBOL' ? 'none' : 'unknown' },
        phrases: { scope: runEvidence.state === 'observed' ? 'delimited_and_cell_runs' : 'delimited_only', runCoverage: runEvidence.state, truncated: result.spanCoverage === 'partial', candidates },
        scripts,
    };
}
