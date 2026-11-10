import { HP_TEXT_PATTERN, templatePlainText } from './hwpx/xmlText';
import type { Paragraph } from './template-derive/types';

type Runs = Paragraph['runs'];
export type RunEvidence = { state: 'observed'; runs: Runs } | { state: 'unavailable' } | { state: 'not_applicable' };

/** Only unambiguous direct runs with confirmed style differences enter the candidate rule. */
export function observedCellRuns(xml: string, fullText: string, different: (left: string, right: string) => boolean | null): RunEvidence {
    const matches: RegExpMatchArray[] = [];
    for (const match of xml.matchAll(/<hp:run\b([^>]*?)(?:\/>|>([\s\S]*?)<\/hp:run>)/g)) {
        if (matches.length >= 4096) return { state: 'unavailable' };
        matches.push(match);
    }
    let openCount = 0;
    for (const match of xml.matchAll(/<hp:run(?:\s|\/?>)/g))
        if (match.index === undefined || ++openCount > 4096) return { state: 'unavailable' };
    if (!matches.length || matches.length !== openCount)
        return { state: 'unavailable' };
    const ids: string[] = [], runs: Runs = [];
    let position = 0, combined = '';
    for (const match of matches) {
        const attrs = match[1], inner = match[2] ?? '';
        if (/<hp:run(?:\s|\/?>)/.test(inner)) return { state: 'unavailable' };
        // KORDOC sees run-level line breaks but the current text extractor only
        // sees those inside hp:t; do not claim aligned offsets in that case.
        if (/<hp:lineBreak\b/.test(inner.replace(HP_TEXT_PATTERN, ''))) return { state: 'unavailable' };
        const refs = [...attrs.matchAll(/\bcharPrIDRef="(\d+)"/g)];
        if (refs.length !== 1 || refs[0][1].length > 10) return { state: 'unavailable' };
        const id = refs[0][1];
        let index = ids.indexOf(id);
        if (index < 0) { if (ids.length >= 32) return { state: 'unavailable' }; index = ids.push(id) - 1; }
        const part = templatePlainText(match[0]);
        let length = 0;
        for (let offset = 0; offset < part.length; length++) {
            const point = part.codePointAt(offset);
            offset += point !== undefined && point > 0xffff ? 2 : 1;
        }
        runs.push({ start: position, length, characterStyle: index });
        position += length; combined += part;
    }
    if (combined !== fullText) return { state: 'unavailable' };
    for (const id of ids) if (different(id, id) !== false) return { state: 'unavailable' };
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++)
        if (different(ids[i], ids[j]) !== true) return { state: 'unavailable' };
    return { state: 'observed', runs };
}
