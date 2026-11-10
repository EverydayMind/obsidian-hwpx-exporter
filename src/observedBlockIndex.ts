import type { PandocAST, PandocBlock, PandocInline, PandocTableCell, PandocTableRow } from './types';
import { SelectionRecorder, type ImageOutcome, type SelectionFact } from './selectionObservation';
import { OutputParagraphAnchors } from './outputParagraphAnchors';
import { htmlCommentsOnly } from './htmlComments';

type Container = 'body' | 'list' | 'table_cell' | 'caption' | 'footnote' | 'quote' | 'callout';
type Kind = 'heading' | 'paragraph' | 'list_item' | 'figure' | 'table' | 'table_cell' | 'caption' | 'footnote' | 'quote' | 'callout' | 'code' | 'hr';
type BlockImages = { basis: 'renderer_output'; requested: number; pictureReferences: number;
    textSubstitutions: number; omitted: number; firstOutcome: ImageOutcome };
export type ObservedBlock = {
    index: number;
    parentIndex: number | null;
    container: Container;
    kind: Kind;
    depth: number;
    headingLevel: number | null;
    selection: SelectionFact;
    images: BlockImages | null;
    generatedFrom: number | null;
    calloutTitleOrigin: 'explicit' | 'default_type' | 'unknown' | null;
    codeLabelSelection: SelectionFact | null;
};
type Reason = 'observation_limit' | 'block_limit' | 'unsupported_inline' | 'unsupported_block' |
    'missing_observation' | 'invalid_table_geometry' | 'unrendered_table_rows' | 'generated_cell' |
    'unsupported_list_order';
export type ObservedBlockIndex =
    { state: 'complete_for_supported_input'; coverage: 'partial_rendered_structure'; blocks: ObservedBlock[] } |
    { state: 'unavailable'; reason: Reason; blocks: [] };

// The provider only exports indices produced in this process by the converter's
// recorder. In particular, an older or fake host cannot supply a raw block array.
const recordedIndices = new WeakSet<object>();
export function isRecordedObservedBlockIndex(value: unknown): value is ObservedBlockIndex {
    return !!value && typeof value === 'object' && recordedIndices.has(value);
}

/** Captures the single AST used by the converter, not a second Markdown parse. */
export class ObservedBlockRecorder extends SelectionRecorder {
    private ast: PandocAST | null = null;
    private readonly outputParagraphs = new OutputParagraphAnchors();
    recordParagraphOutput(fact: SelectionFact, xml: string): void { this.outputParagraphs.record(fact, xml); }
    recordFirstParagraphMerge(original: string, merged: string): void { this.outputParagraphs.recordFirstMerge(original, merged); }
    finishSectionOutput(xml: string): void { this.outputParagraphs.finish(xml); }
    finishArchiveOutput(bytes: Uint8Array): void { this.outputParagraphs.finishArchive(bytes); }
    outputAnchors(index: ObservedBlockIndex) { return this.outputParagraphs.index(index); }
    begin(ast: PandocAST): void {
        if (this.ast) throw new Error('The block recorder cannot be reused across conversions.');
        this.ast = ast;
    }
    index(): ObservedBlockIndex {
        const index: ObservedBlockIndex = this.ast ? indexObservedBlocks(this.ast, this)
            : { state: 'unavailable', reason: 'missing_observation', blocks: [] };
        recordedIndices.add(index);
        return index;
    }
}

class CannotIndex extends Error {
    constructor(readonly reason: Reason) { super(reason); }
}

/**
 * A private intermediate index over the *same* AST that was rendered. This is
 * intentionally not the E3 public contract: unsupported input fails closed,
 * including nested footnotes and unobserved block kinds. A picture
 * reference is a renderer observation, not evidence of packaged image bytes.
 */
export function indexObservedBlocks(ast: PandocAST, recorder: SelectionRecorder): ObservedBlockIndex {
    const blocks: ObservedBlock[] = [];
    const fail = (reason: Reason): never => { throw new CannotIndex(reason); };
    let nesting = 0;
    let noteNesting = 0;
    let remainingGridCells = 200000;
    const nested = (action: () => void): void => {
        if (nesting >= 128) return fail('block_limit');
        nesting++;
        try { action(); } finally { nesting--; }
    };
    const own = (target: object, kind: SelectionFact['kind']): SelectionFact => {
        const facts = recorder.forTarget(target).filter(fact => fact.kind === kind);
        if (facts.length !== 1) return fail('missing_observation');
        return facts[0];
    };
    const add = (kind: Kind, container: Container, parentIndex: number | null, depth: number,
        headingLevel: number | null, selection: SelectionFact, images: BlockImages | null = null,
        generatedFrom: number | null = null, calloutTitleOrigin: ObservedBlock['calloutTitleOrigin'] = null,
        codeLabelSelection: SelectionFact | null = null): number => {
        if (blocks.length >= 50000) return fail('block_limit');
        const index = blocks.length;
        blocks.push({ index, parentIndex, container, kind, depth, headingLevel, selection, images, generatedFrom, calloutTitleOrigin, codeLabelSelection });
        return index;
    };
    const checkInlines = (inlines: PandocInline[]): { images: BlockImages | null; notes: PandocBlock[][] } => {
        const queue: unknown[] = [inlines];
        const outcomes: ImageOutcome[] = [];
        const notes: PandocBlock[][] = [];
        let visited = 0;
        while (queue.length) {
            const value = queue.pop();
            if (!value || typeof value !== 'object') continue;
            if (++visited > 200000) return fail('unsupported_inline');
            if (!Array.isArray(value)) {
                const node = value as { t?: unknown; c?: unknown };
                if (node.t === 'Note') {
                    if (!Array.isArray(node.c)) return fail('missing_observation');
                    notes.push(node.c as PandocBlock[]);
                    continue;
                }
                if (node.t === 'Image') {
                    if (!Array.isArray(node.c)) return fail('missing_observation');
                    const found = recorder.forImage(node.c);
                    if (found.length !== 1) return fail('missing_observation');
                    outcomes.push(found[0]);
                }
                if (node.c && typeof node.c === 'object') queue.push(node.c);
            } else {
                if (queue.length + value.length > 200000) return fail('unsupported_inline');
                for (let i = value.length - 1; i >= 0; i--) queue.push(value[i]);
            }
        }
        const images: BlockImages | null = !outcomes.length ? null : { basis: 'renderer_output', requested: outcomes.length,
            pictureReferences: outcomes.filter(value => value === 'picture_reference').length,
            textSubstitutions: outcomes.filter(value => value === 'text_substitution').length,
            omitted: outcomes.filter(value => value === 'omitted').length, firstOutcome: outcomes[0] };
        return { images, notes };
    };
    const addNotes = (notes: PandocBlock[][], parent: number, depth: number): void => {
        if (notes.length && noteNesting) return fail('unsupported_inline');
        for (const note of notes) {
            noteNesting++;
            try {
                const generated = recorder.forTarget(note).filter(fact => fact.kind === 'footnote' && fact.origin === 'generated');
                const hasSourceParagraph = note.some(block => block.t === 'Para' || block.t === 'Plain');
                if (generated.length !== (hasSourceParagraph ? 0 : 1)) return fail('missing_observation');
                if (generated.length) add('footnote', 'footnote', parent, depth, null, generated[0]);
                for (const block of note) {
                    if (block.t !== 'Para' && block.t !== 'Plain') {
                        walk(block, parent, 'footnote', depth);
                        continue;
                    }
                    const found = checkInlines(block.c);
                    if (found.notes.length) return fail('unsupported_inline');
                    const fact = own(block.c, 'footnote');
                    if (fact.origin !== 'source') return fail('missing_observation');
                    add('footnote', 'footnote', parent, depth, null, fact, found.images);
                }
            } finally {
                noteNesting--;
            }
        }
    };
    const list = (items: PandocBlock[][], parent: number | null, depth: number): void => nested(() => {
        for (const item of items) {
            const first = item[0];
            if (!first || (first.t !== 'Plain' && first.t !== 'Para')) return fail('unsupported_list_order');
            const found = checkInlines(first.c);
            const index = add('list_item', 'list', parent, depth, null, own(first.c, 'list_item'), found.images);
            addNotes(found.notes, index, depth);
            for (const child of item.slice(1)) {
                if (child.t === 'BulletList') list(child.c, index, depth + 1);
                else if (child.t === 'OrderedList') list(child.c[1], index, depth + 1);
                else walk(child, index, 'list', depth);
            }
        }
    });
    const table = (block: Extract<PandocBlock, { t: 'Table' }>, parent: number | null,
        container: Container, depth: number): void => {
        const fact = own(block.c, 'table');
        if (!fact.table) return fail('missing_observation');
        if (block.c[4].some(body => body[2].length > 0) || block.c[5][1].length > 0)
            return fail('unrendered_table_rows');
        const { rows, cols, headerRows } = fact.table;
        const actualRows: PandocTableRow[] = [...block.c[3][1], ...block.c[4].flatMap(body => body[3])];
        if (rows !== actualRows.length || cols !== block.c[2].length || headerRows !== block.c[3][1].length ||
            rows < 1 || cols < 1) return fail('invalid_table_geometry');
        const gridCells = rows * cols;
        if (!Number.isSafeInteger(gridCells) || gridCells > remainingGridCells) return fail('block_limit');
        remainingGridCells -= gridCells;
        const index = add('table', container, parent, depth, null, fact);
        const covered = new Set<number>();
        const generatedCells = recorder.forTarget(block.c).filter(item => item.kind === 'table_cell' && item.origin === 'generated');
        const generatedParagraphs = recorder.forTarget(block.c).filter(item => item.kind === 'cell_paragraph' && item.origin === 'generated');
        const generatedByRow = new Map<number, SelectionFact[]>();
        const paragraphsByPosition = new Map<number, SelectionFact>();
        const position = (item: SelectionFact): number => {
            const at = item.cell;
            if (!at || !Number.isSafeInteger(at.row) || !Number.isSafeInteger(at.col) ||
                at.row < 0 || at.row >= rows || at.col < 0 || at.col >= cols) return fail('invalid_table_geometry');
            return at.row * cols + at.col;
        };
        for (const generated of generatedCells) {
            const key = position(generated);
            const row = Math.floor(key / cols);
            const values = generatedByRow.get(row) ?? [];
            values.push(generated);
            generatedByRow.set(row, values);
        }
        for (const paragraph of generatedParagraphs) {
            const key = position(paragraph);
            if (paragraphsByPosition.has(key)) return fail('missing_observation');
            paragraphsByPosition.set(key, paragraph);
        }
        const sameCell = (a: SelectionFact['cell'], b: SelectionFact['cell']): boolean =>
            !!a && !!b && a.row === b.row && a.col === b.col && a.rowSpan === b.rowSpan && a.colSpan === b.colSpan &&
            a.rows === b.rows && a.cols === b.cols && a.headerRow === b.headerRow;
        for (const [rowIndex, row] of actualRows.entries()) {
            const entries: Array<{ cell: PandocTableCell | null; fact: SelectionFact }> = [
                ...row[1].map(cell => ({ cell, fact: own(cell, 'table_cell') })),
                ...(generatedByRow.get(rowIndex) ?? []).map(item => ({ cell: null, fact: item })),
            ];
            let lastCol = -1;
            for (const entry of entries) {
                const { cell, fact: cellFact } = entry;
                const at = cellFact.cell;
                if (!at || ![at.row, at.col, at.rowSpan, at.colSpan].every(Number.isSafeInteger) ||
                    at.row !== rowIndex || at.rows !== rows || at.cols !== cols ||
                    at.headerRow !== (rowIndex < headerRows) || at.rowSpan < 1 || at.colSpan < 1 ||
                    at.col <= lastCol || at.row + at.rowSpan > rows || at.col + at.colSpan > cols ||
                    cellFact.origin !== (cell ? 'source' : 'generated'))
                    return fail('invalid_table_geometry');
                lastCol = at.col;
                for (let r = at.row; r < at.row + at.rowSpan; r++) {
                    for (let c = at.col; c < at.col + at.colSpan; c++) {
                        const position = r * cols + c;
                        if (covered.has(position)) return fail('invalid_table_geometry');
                        covered.add(position);
                    }
                }
                const cellIndex = add('table_cell', 'table_cell', index, depth, null, cellFact);
                if (cell) {
                    const empty = recorder.forTarget(cell).filter(item => item.kind === 'cell_paragraph' && item.origin === 'generated');
                    if (!cell[4].length) {
                        if (empty.length !== 1 || !sameCell(empty[0].cell, at)) return fail('missing_observation');
                        add('paragraph', 'table_cell', cellIndex, depth, null, empty[0]);
                    } else {
                        if (empty.length) return fail('unsupported_block');
                        for (const child of cell[4]) walk(child, cellIndex, 'table_cell', depth);
                    }
                } else {
                    const key = position(cellFact);
                    const paragraph = paragraphsByPosition.get(key);
                    if (!paragraph || !sameCell(paragraph.cell, at)) return fail('missing_observation');
                    paragraphsByPosition.delete(key);
                    add('paragraph', 'table_cell', cellIndex, depth, null, paragraph);
                }
            }
        }
        if (covered.size !== rows * cols) return fail('generated_cell');
        if (paragraphsByPosition.size) return fail('missing_observation');
    };
    const walk = (block: PandocBlock, parent: number | null, container: Container, depth: number, quoteParagraph = false): void => nested(() => {
        if (block.t === 'RawBlock' && block.c[0] === 'html' && htmlCommentsOnly(block.c[1])) return;
        if (block.t === 'Header') {
            const found = checkInlines(block.c[2]);
            const index = add('heading', container, parent, depth, block.c[0], own(block.c[2], 'heading'), found.images);
            addNotes(found.notes, index, depth);
        } else if (block.t === 'Para' || block.t === 'Plain') {
            const found = checkInlines(block.c);
            const images = found.images;
            const captions = recorder.forTarget(block.c).filter(fact => fact.kind === 'caption');
            if (captions.length && captions[0].captionOrigin === 'source') {
                if (captions.length !== 1) return fail('missing_observation');
                const index = add('caption', 'caption', parent, depth, null, captions[0], images);
                addNotes(found.notes, index, depth);
            } else {
                const imageOnly = !!images && block.c.every(item => ['Image', 'Space', 'SoftBreak', 'LineBreak'].includes(item.t));
                const index = add(imageOnly ? 'figure' : 'paragraph', container, parent, depth, null,
                    own(block.c, container === 'table_cell' ? 'cell_paragraph' : quoteParagraph ? 'quote_paragraph' : 'body'), images);
                addNotes(found.notes, index, depth);
                if (captions.length) {
                    if (captions.length !== 1 || captions[0].captionOrigin !== 'first_image' || !imageOnly)
                        return fail('missing_observation');
                    add('caption', 'caption', parent, depth, null, captions[0], null, index);
                }
            }
        } else if (block.t === 'BulletList') list(block.c, parent, depth + 1);
        else if (block.t === 'OrderedList') list(block.c[1], parent, depth + 1);
        else if (block.t === 'CodeBlock') {
            const fact = own(block.c, 'code');
            if (!fact.code) return fail('missing_observation');
            const labels = recorder.forTarget(block.c).filter(item => item.kind === 'body' && item.requested.marker === '{{CODE_LANG}}');
            if (labels.length !== (fact.code.languageLabel === 'emitted' ? 1 : 0)) return fail('missing_observation');
            add('code', container, parent, depth, null, fact, null, null, null, labels[0] ?? null);
        } else if (block.t === 'HorizontalRule')
            add('hr', container, parent, depth, null, own(block, 'hr'));
        else if (block.t === 'Table') table(block, parent, container, depth);
        else if (block.t === 'BlockQuote') {
            const index = add('quote', container, parent, depth, null, own(block.c, 'quote'));
            for (const child of block.c)
                walk(child, index, 'quote', depth, child.t === 'Para' || child.t === 'Plain');
        } else if (block.t === 'Div' && block.c[0][1].includes('callout')) {
            const fact = own(block.c, 'callout');
            if (fact.containerMode !== 'callout_quote' && fact.containerMode !== 'callout_body_variant')
                return fail('missing_observation');
            const index = add('callout', container, parent, depth, null, fact);
            const first = block.c[1][0];
            const title = first?.t === 'Div' && first.c[0][1].includes('callout-title') ? first : null;
            if (title) {
                const part = title.c[1][0];
                if (title.c[1].length !== 1 || !part || (part.t !== 'Plain' && part.t !== 'Para'))
                    return fail('unsupported_block');
                if (part.c.length) {
                    const facts = recorder.forTarget(part.c).filter(item => item.kind === 'body' || item.kind === 'quote_paragraph');
                    if (facts.length !== 1) return fail('missing_observation');
                    const originValue = title.c[0][2].find(([key]) => key === 'title-origin')?.[1];
                    const origin = originValue === 'explicit' || originValue === 'default_type' ? originValue : 'unknown';
                    const found = checkInlines(part.c);
                    const titleIndex = add('paragraph', 'callout', index, depth, null, facts[0], found.images, null, origin);
                    addNotes(found.notes, titleIndex, depth);
                }
            }
            for (const child of block.c[1].slice(title ? 1 : 0))
                walk(child, index, 'callout', depth,
                    fact.containerMode === 'callout_quote' && (child.t === 'Para' || child.t === 'Plain'));
        }
        else if (block.t === 'Div' && block.c[0][1].includes('hwpx-style') &&
            !block.c[0][1].includes('callout') && !block.c[0][1].includes('math')) {
            for (const child of block.c[1]) walk(child, parent, container, depth);
        } else return fail('unsupported_block');
    });
    try {
        if (recorder.summary().dropped || recorder.summary().images.dropped) return fail('observation_limit');
        for (const block of ast.blocks) walk(block, null, 'body', 0);
        return { state: 'complete_for_supported_input', coverage: 'partial_rendered_structure', blocks };
    } catch (error) {
        if (error instanceof CannotIndex) return { state: 'unavailable', reason: error.reason, blocks: [] };
        throw error;
    }
}
