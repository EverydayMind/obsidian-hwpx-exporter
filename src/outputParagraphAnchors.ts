import { omitTextParagraphLineSegments } from './hwpx/packaging';
import { createHash } from 'crypto';
import type { ObservedBlockIndex } from './observedBlockIndex';
import type { SelectionFact } from './selectionObservation';

const MAX_XML_LENGTH = 16 * 1024 * 1024;
const MAX_PARAGRAPHS = 50000;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/** A rule may emit blank spacer paragraphs around exactly one text paragraph. */
function soleTextParagraph(xml: string): string | null {
    if (xml.length > MAX_XML_LENGTH || /<!--|<!\[CDATA\[|<!DOCTYPE/i.test(xml)) return null;
    const roots: string[] = [], stack: number[] = [];
    let end = 0, nested = false;
    for (const match of xml.matchAll(/<hp:p\b[^>]*>|<\/hp:p>/g)) {
        if (match[0] !== '</hp:p>') {
            if (match[0].endsWith('/>')) return null;
            if (!stack.length && xml.slice(end, match.index).trim()) return null;
            if (stack.length) nested = true;
            stack.push(match.index);
        } else {
            const start = stack.pop();
            if (start === undefined) return null;
            if (!stack.length) { end = match.index + match[0].length; roots.push(xml.slice(start, end)); }
        }
        if (roots.length > MAX_PARAGRAPHS) return null;
    }
    if (stack.length || nested || xml.slice(end).trim() || !roots.length) return null;
    const withText = roots.filter(root => [...root.matchAll(/<hp:t(?:\s[^>]*)?>([\s\S]*?)<\/hp:t>/g)]
        .some(match => match[1].replace(/<[^>]*>/g, '').trim().length > 0));
    if (withText.length !== 1) return null;
    const allowedBlank = new Set(['hp:p', 'hp:run', 'hp:t', 'hp:linesegarray', 'hp:lineseg']);
    if (roots.some(root => root !== withText[0] &&
        [...root.matchAll(/<\/?([A-Za-z_][\w:.-]*)\b/g)].some(match => !allowedBlank.has(match[1])))) return null;
    return withText[0];
}

/** Return only the marker actually selected for this emitted block. */
export function appliedOutputMarker(fact: SelectionFact): string | null {
    if (fact.prefix) {
        const prefix = fact.prefix.marker;
        return prefix?.startsWith('{{') && prefix.endsWith('}}') ? prefix.slice(2, -2).trim() : null;
    }
    const selected = fact.applied;
    if (!selected?.marker || selected.markerState !== 'observed' || selected.variantState === 'redacted') return null;
    const base = selected.marker.slice(2, -2);
    return selected.variantState === 'observed' && selected.variant ? `${base}:${selected.variant}` : base;
}

/** Internal, partial evidence from one completed conversion. */
export class OutputParagraphAnchors {
    private readonly candidates = new WeakMap<SelectionFact, { original: string; packaged: string }>();
    private readonly candidateCounts = new Map<string, number>();
    private firstMerge: { original: string; merged: string } | null = null;
    private pendingMerge: { original: string; merged: string } | null = null;
    private section: Map<string, number | null> | null = null;
    private sectionSha256: string | null = null;
    private archiveSha256: string | null = null;
    private count = 0;

    record(fact: SelectionFact, xml: string): void {
        if (++this.count > MAX_PARAGRAPHS || xml.length > MAX_XML_LENGTH) return;
        const trimmed = xml.trim();
        const single = /^<hp:p(?:\s|>)/.test(trimmed) && trimmed.endsWith('</hp:p>') &&
            (trimmed.match(/<hp:p(?:\s|>)/g) ?? []).length === 1 ? trimmed : soleTextParagraph(trimmed);
        if (!single) return;
        const hash = digest(single);
        const sentinel = '<hp:p></hp:p>';
        const packaged = omitTextParagraphLineSegments(sentinel + single).slice(sentinel.length);
        this.candidates.set(fact, { original: hash, packaged: digest(packaged) });
        this.candidateCounts.set(hash, (this.candidateCounts.get(hash) ?? 0) + 1);
    }

    /** Only the packer's exact first-body merge can establish this mapping. */
    recordFirstMerge(original: string, merged: string): void {
        this.pendingMerge = null;
        if (original.length > MAX_XML_LENGTH || merged.length > MAX_XML_LENGTH) return;
        this.pendingMerge = { original: digest(original.trim()), merged: digest(merged.trim()) };
    }

    finish(xml: string): void {
        this.firstMerge = this.pendingMerge;
        this.pendingMerge = null;
        this.section = null;
        this.sectionSha256 = null;
        this.archiveSha256 = null;
        if (xml.length > MAX_XML_LENGTH || /<!--|<!\[CDATA\[|<!DOCTYPE/i.test(xml)) return;
        const positions = new Map<string, number | null>();
        const stack: Array<{ start: number; top: number | null }> = [];
        let seen = 0, top = 0, hashedLength = 0;
        for (const match of xml.matchAll(/<hp:p\b[^>]*>|<\/hp:p>/g)) {
            if (match[0] !== '</hp:p>') {
                if (match[0].endsWith('/>') || ++seen > MAX_PARAGRAPHS) return;
                stack.push({ start: match.index, top: stack.length === 0 ? top++ : null });
                continue;
            }
            const entry = stack.pop();
            if (!entry) return;
            const end = match.index + match[0].length;
            hashedLength += end - entry.start;
            if (hashedLength > MAX_XML_LENGTH * 2) return;
            const hash = digest(xml.slice(entry.start, end));
            positions.set(hash, positions.has(hash) ? null : entry.top);
        }
        if (stack.length) return;
        this.section = positions;
        this.sectionSha256 = digest(xml);
    }

    finishArchive(bytes: Uint8Array): void {
        this.archiveSha256 = null;
        if (this.section && bytes.byteLength <= MAX_ARCHIVE_BYTES)
            this.archiveSha256 = createHash('sha256').update(bytes).digest('hex');
    }

    index(blocks: ObservedBlockIndex) {
        if (!this.section || !this.sectionSha256 || !this.archiveSha256 || blocks.state !== 'complete_for_supported_input')
            return { state: 'unavailable' as const, anchors: [] };
        const positions = this.section;
        const byIndex = new Map(blocks.blocks.map(block => [block.index, block]));
        // A list continuation paragraph belongs to the body only when its list
        // starts there: follow the items up to the outermost one, which must
        // have no parent block. Lists in quotes, callouts and cells keep their
        // container's rule (no anchors), as their other paragraphs do.
        const inBodyList = (block: ObservedBlockIndex['blocks'][number]): boolean => {
            let item = block.parentIndex === null ? undefined : byIndex.get(block.parentIndex);
            while (item?.kind === 'list_item' && item.parentIndex !== null) item = byIndex.get(item.parentIndex);
            return item?.kind === 'list_item' && item.parentIndex === null;
        };
        const anchors = blocks.blocks.flatMap(block => {
            // Partial evidence must not turn a redacted request into "no request".
            if (block.selection.requested.variantState === 'redacted') return [];
            const candidate = this.candidates.get(block.selection);
            if (!candidate || this.candidateCounts.get(candidate.original) !== 1) return [];
            const mapped = this.firstMerge?.original === candidate.original
                ? this.firstMerge.merged : candidate.packaged;
            const paragraph = positions.get(mapped);
            // Inside a list that starts in the body, two kinds are body
            // paragraphs of the output: a top-level item (no parent block)
            // rendered through a literal prefix rule (the derived {{-}} rule),
            // and a continuation paragraph, which the converter renders exactly
            // like a top-level paragraph. Items on the list fallback path stay
            // unanchored.
            const anchorable = block.container === 'body'
                || (block.container === 'list' && block.kind === 'paragraph' && inBodyList(block))
                || (block.container === 'list' && block.kind === 'list_item' && block.parentIndex === null && !!block.selection.prefix);
            return typeof paragraph === 'number' && anchorable
                ? [{ blockIndex: block.index, section: 0, paragraph, appliedMarker: appliedOutputMarker(block.selection),
                    requestedVariant: block.selection.requested.variant,
                    variantMissing: block.selection.fallbacks.includes('variant_missing') }]
                : [];
        });
        const counts = new Map<number, number>();
        for (const anchor of anchors) counts.set(anchor.paragraph, (counts.get(anchor.paragraph) ?? 0) + 1);
        return { state: 'partial' as const, anchorVersion: '0.3' as const, sectionSha256: this.sectionSha256, archiveSha256: this.archiveSha256,
            anchors: anchors.filter(anchor => counts.get(anchor.paragraph) === 1) };
    }
}
