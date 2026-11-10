import { HP_TEXT_PATTERN, templatePlainText } from './hwpx/xmlText';

export type DraftScripts =
    | { state: 'observed'; superscript: number; subscript: number; numericSuperscript: number; truncated: boolean }
    | { state: 'unavailable' };

/** Measure only direct, aligned emitted runs; never include their text in the result. */
export function observeDraftScripts(xml: string, fullText: string,
    state: ((id: string) => 'normal' | 'superscript' | 'subscript' | 'unknown') | undefined): DraftScripts {
    if (!state) return { state: 'unavailable' };
    const matches: RegExpMatchArray[] = [];
    for (const match of xml.matchAll(/<hp:run\b([^>]*?)(?:\/>|>([\s\S]*?)<\/hp:run>)/g)) {
        if (matches.length >= 4096) return { state: 'unavailable' };
        matches.push(match);
    }
    let openings = 0;
    for (const _match of xml.matchAll(/<hp:run(?:\s|\/?>)/g))
        if (++openings > 4096) return { state: 'unavailable' };
    if (!matches.length || matches.length !== openings) return { state: 'unavailable' };
    let combined = '';
    const parts: Array<{ kind: 'normal' | 'superscript' | 'subscript'; text: string }> = [];
    for (const match of matches) {
        const inner = match[2] ?? '';
        if (/<hp:run(?:\s|\/?>)/.test(inner) || /<hp:lineBreak\b/.test(inner.replace(HP_TEXT_PATTERN, ''))) return { state: 'unavailable' };
        const ids = [...match[1].matchAll(/\bcharPrIDRef="(\d+)"/g)];
        if (ids.length !== 1 || ids[0][1].length > 10) return { state: 'unavailable' };
        const kind = state(ids[0][1]);
        if (kind === 'unknown') return { state: 'unavailable' };
        const text = templatePlainText(match[0]);
        combined += text;
        const prior = parts[parts.length - 1];
        if (prior && prior.kind === kind) prior.text += text;
        else parts.push({ kind, text });
    }
    if (combined !== fullText) return { state: 'unavailable' };
    let superscript = 0, subscript = 0, numericSuperscript = 0, count = 0, truncated = false;
    for (const part of parts) {
        const value = part.text.trim();
        if (!value || part.kind === 'normal') continue;
        if (count === 32) { truncated = true; break; }
        count++;
        if (part.kind === 'superscript') {
            superscript++;
            if (/^\d{1,4}$/u.test(value)) numericSuperscript++;
        } else subscript++;
    }
    return { state: 'observed', superscript, subscript, numericSuperscript, truncated };
}
