import { parseVariantMarker } from './template-derive/variantMarkers';
import type { PandocAST } from './types';
import { textFeatures, type TextFeatures } from './template-derive/text-features';
import { HP_TEXT_PATTERN, templatePlainText } from './hwpx/xmlText';
import { draftTextSemantics, type DraftTextSemantics } from './draftTextSemantics';
import { observedCellRuns } from './draftStyledRuns';
import { observeDraftScripts } from './draftScripts';

type VariantState = 'none' | 'observed' | 'redacted';
type Marker = { marker: string | null; markerState: 'none' | 'observed' | 'redacted'; variant: string | null; variantState: VariantState };
type Prefix = { kind: 'literal' | 'number' | 'number-period' | 'heading_number'; marker: string | null };
export type ImageOutcome = 'picture_reference' | 'text_substitution' | 'omitted';
const UNOBSERVED_KINDS = ['other_caption', 'footnote_nested_blocks', 'quote_spacer', 'code_surrounding_paragraphs', 'hr_surrounding_paragraphs', 'figure'];
export type SelectionFact = {
    kind: 'heading' | 'body' | 'list_item' | 'table' | 'table_cell' | 'cell_paragraph' | 'caption' | 'footnote' | 'quote' | 'callout' | 'quote_paragraph' | 'code' | 'hr';
    requestKind: 'explicit' | 'implicit_candidates' | 'implicit_structure' | 'inherited_cell';
    requested: Marker;
    applied: Marker;
    candidates: Marker[] | null;
    cell: { row: number; col: number; rowSpan: number; colSpan: number; rows: number; cols: number; headerRow: boolean } | null;
    table: { rows: number; cols: number; headerRows: number; wrapper: 'rule' | 'direct' | 'generated' } | null;
    captionOrigin: 'source' | 'first_image' | null;
    origin?: 'source' | 'generated';
    containerMode?: 'quote' | 'callout_quote' | 'callout_body_variant';
    code?: { lineCount: number; languageLabel: 'emitted' | 'not_requested' | 'not_rendered'; leadingSurroundings: boolean; trailingSurroundings: boolean };
    hr?: { mode: 'marker' | 'two_spacers'; leadingSurroundings: boolean; trailingSurroundings: boolean };
    text: { state: 'observed'; basis: 'emitted_xml_text' | 'footnote_content_xml_text' | 'code_content_xml_text'; features: TextFeatures; semantics: DraftTextSemantics } |
        { state: 'unavailable'; reason: 'complex_output' | 'size_limit' | 'not_observed' } |
        { state: 'not_applicable' };
    prefix: Prefix | null;
    variantConsidered: boolean;
    fallbackSource: 'none' | 'normal' | 'dynamic_heading' | 'body' | 'named_footnote_style' | 'body_indent' | 'normal_indent' | 'cell_normal' | 'inherited_cell';
    fallbacks: Array<'variant_unsupported' | 'variant_missing' | 'marker_missing'>;
};

/** Trusted in-process hook: targets are AST identities and must never be serialized. */
export interface SelectionObserver {
    begin?(ast: PandocAST): void;
    record(target: object, fact: SelectionFact): void;
    recordImage?(target: object, outcome: ImageOutcome): void;
    shouldCaptureText?(): boolean;
    /** Internal only: emitted XML is never serialized into an observation. */
    recordParagraphOutput?(fact: SelectionFact, xml: string): void;
    /** Exact packaging transformation; internal only, never serialized. */
    recordFirstParagraphMerge?(original: string, merged: string): void;
    finishSectionOutput?(xml: string): void;
    finishArchiveOutput?(bytes: Uint8Array): void;
}

function variant(value: string | null): { variant: string | null; variantState: VariantState } {
    if (!value) return { variant: null, variantState: 'none' };
    return parseVariantMarker(`BODY:${value}`)
        ? { variant: value, variantState: 'observed' }
        : { variant: null, variantState: 'redacted' };
}

function marker(value: string | null, valueVariant: string | null): Marker {
    const safe = value && /^(?:H[1-9]|BODY|FIGURE|CAPTION|TABLE_CAPTION|FOOTNOTE|QUOTE(?:_(?:INFO|WARN|SUCCESS|DANGER))?|CALLOUT_(?:NOTE|WARNING|INFO|TIP|SUCCESS|DANGER|TITLE(?:_(?:NOTE|WARNING|INFO|WARN|TIP|SUCCESS|DANGER))?)|CODE|CODE_LANG|HR|LIST_(?:BULLET|ORDERED)_[1-9]\d?|CELL_(?:BODY|NUMBER|STUB|(?:ODD|EVEN)(?:_(?:LEFT|CENTER|RIGHT))?|(?:HEADER|TOP|MIDDLE|BOTTOM)_(?:LEFT|CENTER|RIGHT)))$/.test(value)
        ? `{{${value}}}` : null;
    return { marker: safe, markerState: !value ? 'none' : safe ? 'observed' : 'redacted', ...variant(valueVariant) };
}

function safePrefix(value: string): string | null {
    // Prefix rules may contain arbitrary Hangul text; only fixed symbols and
    // numeric heading forms may leave the in-memory conversion.
    return /^\{\{ *(?:~)?(?:[□■○●◦ㅇ•※▶▷▪◆◇ㆍ–—―*-]|\d{1,3}\.?)\}\}$/u.test(value) ||
        /^\{\{H[1-9]:(?:1(?:\.1)*[.)]?|\(1(?:\.1)*\))(?::(?:keep|strip))?\}\}$/.test(value)
        ? value : null;
}

export function selectionFact(input: {
    kind: Exclude<SelectionFact['kind'], 'table_cell' | 'table' | 'quote' | 'callout'>; base: string; requestedVariant: string | null;
    appliedKey: string | null; prefix?: { kind: Prefix['kind']; marker: string };
    variantConsidered: boolean; fallbackSource: SelectionFact['fallbackSource'];
    fallbacks: SelectionFact['fallbacks'];
    text?: SelectionFact['text'];
    requestKind?: 'explicit' | 'implicit_candidates' | 'implicit_structure' | 'inherited_cell';
    cell?: SelectionFact['cell'];
    captionOrigin?: SelectionFact['captionOrigin'];
    code?: SelectionFact['code'];
    hr?: SelectionFact['hr'];
    origin?: SelectionFact['origin'];
}): SelectionFact {
    const [base, ...rest] = (input.appliedKey ?? '').split(':');
    const appliedVariant = rest.length ? rest.join(':') : null;
    return {
        kind: input.kind,
        requestKind: input.requestKind ?? 'explicit',
        requested: marker(input.base, input.requestedVariant),
        applied: marker(base || null, appliedVariant),
        candidates: null,
        cell: input.cell ?? null,
        table: null,
        captionOrigin: input.captionOrigin ?? null,
        ...(input.origin ? { origin: input.origin } : {}),
        ...(input.code ? { code: { ...input.code } } : {}),
        ...(input.hr ? { hr: { ...input.hr } } : {}),
        text: input.text ?? { state: 'unavailable', reason: 'not_observed' },
        prefix: input.prefix ? { kind: input.prefix.kind, marker: safePrefix(input.prefix.marker) } : null,
        variantConsidered: input.variantConsidered,
        fallbackSource: input.fallbackSource,
        fallbacks: [...new Set(input.fallbacks)],
    };
}

/** Only a single unambiguous emitted paragraph is eligible; never return its text. */
export function emittedTextObservation(xml: string, inCell = false, different?: (left: string, right: string) => boolean | null,
    scriptState?: (id: string) => 'normal' | 'superscript' | 'subscript' | 'unknown'): SelectionFact['text'] {
    if (xml.length > 16 * 1024 * 1024) return { state: 'unavailable', reason: 'size_limit' };
    if ((xml.match(/<hp:p(?:\s|>)/g) ?? []).length !== 1 || /&#(?:x[0-9a-f]+|\d+);/i.test(xml))
        return { state: 'unavailable', reason: 'complex_output' };
    // Unknown XML can contain text belonging to objects or controls, not this
    // paragraph. Prefer missing features to attributing another object's text.
    for (const tag of xml.matchAll(/<[^>]+>/g))
        if (!/^<\/?hp:(?:p|run|t|tab|lineBreak)(?:\s|\/?>)/.test(tag[0]))
            return { state: 'unavailable', reason: 'complex_output' };
    for (const match of xml.matchAll(HP_TEXT_PATTERN)) {
        for (const tag of match[2].matchAll(/<[^>]+>/g))
            if (!/^<hp:(?:tab|lineBreak)\b[^>]*\/>$/.test(tag[0]))
                return { state: 'unavailable', reason: 'complex_output' };
    }
    try {
        const value = templatePlainText(xml), features = textFeatures(value);
        const runs = inCell ? different ? observedCellRuns(xml, value, different) : { state: 'unavailable' as const } : { state: 'not_applicable' as const };
        return { state: 'observed', basis: 'emitted_xml_text', features, semantics: draftTextSemantics(value, features, runs, observeDraftScripts(xml, value, scriptState)) };
    } catch (error) {
        if (error instanceof RangeError) return { state: 'unavailable', reason: 'size_limit' };
        throw error;
    }
}

export function cellSelectionFact(input: {
    variant: string | null; candidateKeys: string[]; selectedKey: string | null;
    cell: NonNullable<SelectionFact['cell']>;
    origin?: 'source' | 'generated';
}): SelectionFact {
    const [selected, ...rest] = (input.selectedKey ?? '').split(':');
    const selectedVariant = rest.length ? rest.join(':') : null;
    const candidates = input.candidateKeys.flatMap(key => input.variant
        ? [marker(`CELL_${key}`, input.variant), marker(`CELL_${key}`, null)]
        : [marker(`CELL_${key}`, null)]);
    return {
        kind: 'table_cell', requestKind: 'implicit_candidates', requested: marker(null, input.variant),
        applied: marker(selected ? `CELL_${selected}` : null, selectedVariant), candidates,
        cell: { ...input.cell }, table: null, captionOrigin: null, origin: input.origin ?? 'source',
        text: { state: 'not_applicable' }, prefix: null, variantConsidered: true,
        fallbackSource: input.selectedKey ? 'none' : 'cell_normal',
        fallbacks: [...(input.variant && !selectedVariant ? ['variant_missing' as const] : []),
            ...(!input.selectedKey ? ['marker_missing' as const] : [])],
    };
}

/** Table geometry follows only the rows the renderer actually emits. */
export function tableSelectionFact(input: { variant: string | null; table: NonNullable<SelectionFact['table']> }): SelectionFact {
    return {
        kind: 'table', requestKind: 'implicit_structure', requested: marker(null, input.variant),
        applied: marker(null, null), candidates: null, cell: null, table: { ...input.table }, captionOrigin: null,
        text: { state: 'not_applicable' }, prefix: null, variantConsidered: false,
        fallbackSource: 'none', fallbacks: [],
    };
}

/** Structural containers may contain differently styled paragraphs. */
export function containerSelectionFact(kind: 'quote' | 'callout', mode: NonNullable<SelectionFact['containerMode']>): SelectionFact {
    return { kind, requestKind: 'implicit_structure', requested: marker(null, null), applied: marker(null, null),
        candidates: null, cell: null, table: null, captionOrigin: null, containerMode: mode,
        text: { state: 'not_applicable' }, prefix: null, variantConsidered: false, fallbackSource: 'none', fallbacks: [] };
}

/** Bounded ephemeral facts: no AST objects or document text in summary(). */
export class SelectionRecorder implements SelectionObserver {
    private readonly selections = new WeakMap<object, SelectionFact[]>();
    private readonly images = new WeakMap<object, ImageOutcome[]>();
    private readonly counts = { heading: 0, body: 0, list_item: 0, table: 0, table_cell: 0, cell_paragraph: 0, caption: 0, footnote: 0, quote: 0, callout: 0, quote_paragraph: 0, code: 0, hr: 0 };
    private readonly fallbackCounts = { variant_unsupported: 0, variant_missing: 0, marker_missing: 0 };
    private readonly textCounts = { observed: 0, unavailable: 0, not_applicable: 0 };
    private readonly generatedCounts = { table_cell: 0, cell_paragraph: 0, footnote: 0 };
    private seen = 0;
    private dropped = 0;
    private readonly imageCounts = { seen: 0, dropped: 0, picture_reference: 0, text_substitution: 0, omitted: 0 };
    constructor(private readonly maxFacts = 50000) {}
    record(target: object, fact: SelectionFact): void {
        this.seen++;
        if (this.seen > this.maxFacts) { this.dropped++; return; }
        const previous = this.selections.get(target) ?? [];
        previous.push(fact);
        this.selections.set(target, previous);
        this.counts[fact.kind]++;
        if (fact.origin === 'generated' && (fact.kind === 'table_cell' || fact.kind === 'cell_paragraph' || fact.kind === 'footnote'))
            this.generatedCounts[fact.kind]++;
        this.textCounts[fact.text.state]++;
        for (const fallback of fact.fallbacks) this.fallbackCounts[fallback]++;
    }
    shouldCaptureText(): boolean { return this.seen < this.maxFacts; }
    forTarget(target: object): readonly SelectionFact[] { return this.selections.get(target) ?? []; }
    recordImage(target: object, outcome: ImageOutcome): void {
        this.imageCounts.seen++;
        if (this.imageCounts.seen > this.maxFacts) { this.imageCounts.dropped++; return; }
        const previous = this.images.get(target) ?? [];
        previous.push(outcome);
        this.images.set(target, previous);
        this.imageCounts[outcome]++;
    }
    forImage(target: object): readonly ImageOutcome[] { return this.images.get(target) ?? []; }
    summary() {
        return { version: 'selection-observation/0.12', coverage: 'partial' as const,
            scope: 'renderer_selection_calls' as const, notBlockCounts: true as const,
            unobservedKinds: [...UNOBSERVED_KINDS],
            seen: this.seen, dropped: this.dropped,
            captured: { ...this.counts }, generated: { ...this.generatedCounts }, textFeatures: { ...this.textCounts }, fallbacks: { ...this.fallbackCounts },
            images: { ...this.imageCounts } };
    }
}

export type SelectionSummary = ReturnType<SelectionRecorder['summary']>;
/** Validate and copy fixed counters before any host-provided result is exposed. */
export function safeSelectionSummary(input: unknown): SelectionSummary | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const value = input as Record<string, unknown>;
    if (value.version !== 'selection-observation/0.12' || value.coverage !== 'partial' || value.scope !== 'renderer_selection_calls' || value.notBlockCounts !== true ||
        !Array.isArray(value.unobservedKinds) || value.unobservedKinds.length !== UNOBSERVED_KINDS.length ||
        value.unobservedKinds.some((item, index) => item !== UNOBSERVED_KINDS[index]) ||
        !value.captured || typeof value.captured !== 'object' || Array.isArray(value.captured) ||
        !value.generated || typeof value.generated !== 'object' || Array.isArray(value.generated) ||
        !value.fallbacks || typeof value.fallbacks !== 'object' || Array.isArray(value.fallbacks) ||
        !value.textFeatures || typeof value.textFeatures !== 'object' || Array.isArray(value.textFeatures) ||
        !value.images || typeof value.images !== 'object' || Array.isArray(value.images)) return null;
    const captured = value.captured as Record<string, unknown>;
    const generated = value.generated as Record<string, unknown>;
    const fallbacks = value.fallbacks as Record<string, unknown>;
    const textFeatures = value.textFeatures as Record<string, unknown>;
    const images = value.images as Record<string, unknown>;
    const validCount = (item: unknown): item is number => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0;
    const values = [value.seen, value.dropped, captured.heading, captured.body, captured.list_item, captured.table, captured.table_cell, captured.cell_paragraph, captured.caption, captured.footnote, captured.quote, captured.callout, captured.quote_paragraph, captured.code, captured.hr,
        fallbacks.variant_unsupported, fallbacks.variant_missing, fallbacks.marker_missing,
        textFeatures.observed, textFeatures.unavailable, textFeatures.not_applicable,
        images.seen, images.dropped, images.picture_reference, images.text_substitution, images.omitted,
        generated.table_cell, generated.cell_paragraph, generated.footnote];
    if (!values.every(validCount)) return null;
    const [seen, dropped, heading, body, listItem, table, tableCell, cellParagraph, caption, footnote, quote, callout, quoteParagraph, code, hr, unsupported, missing, markerMissing, textObserved, textUnavailable, textNA,
        imageSeen, imageDropped, imagePicture, imageSubstituted, imageOmitted, generatedCell, generatedParagraph, generatedFootnote] = values;
    const total = heading + body + listItem + table + tableCell + cellParagraph + caption + footnote + quote + callout + quoteParagraph + code + hr;
    if (seen !== total + dropped || total > 50000 || unsupported > total || missing > total || markerMissing > total ||
        textObserved + textUnavailable + textNA !== total || textNA !== table + tableCell + quote + callout + hr ||
        imageSeen !== imageDropped + imagePicture + imageSubstituted + imageOmitted ||
        imagePicture + imageSubstituted + imageOmitted > 50000 || generatedCell > tableCell || generatedParagraph > cellParagraph || generatedFootnote > footnote) return null;
    return { version: 'selection-observation/0.12', coverage: 'partial', scope: 'renderer_selection_calls', notBlockCounts: true,
        unobservedKinds: [...UNOBSERVED_KINDS], seen, dropped,
        captured: { heading, body, list_item: listItem, table, table_cell: tableCell, cell_paragraph: cellParagraph, caption, footnote, quote, callout, quote_paragraph: quoteParagraph, code, hr },
        generated: { table_cell: generatedCell, cell_paragraph: generatedParagraph, footnote: generatedFootnote },
        textFeatures: { observed: textObserved, unavailable: textUnavailable, not_applicable: textNA },
        fallbacks: { variant_unsupported: unsupported, variant_missing: missing, marker_missing: markerMissing },
        images: { seen: imageSeen, dropped: imageDropped, picture_reference: imagePicture, text_substitution: imageSubstituted, omitted: imageOmitted } };
}
