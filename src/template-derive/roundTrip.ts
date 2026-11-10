import { canonicalDigest } from './digest';
import { allElements, ancestor } from './dom';
import { children, descendants, is, NS } from './xml';
import { paragraphText, readStructureSource, structureBlocks, type ControlFact, type StructureSource } from './structure';
import { splitFirstParagraphMerge } from './firstParagraphMerge';
import { measureLineCorrespondence } from './roundTripLines';

const normalized = (text: string) => text.replace(/\s+/gu, ' ').trim();
type Line = { ref: string; line: number; key: string };
export type Block = { ref: string; key: string; page: number; spacer: boolean; controls: ControlFact[]; lines: Line[] };
export type RefPair = { sourceRef: string; outputRef: string };
export type Difference = { kind: string; sourceRef: string | null; outputRef: string | null; reason: string };
export type RoundTrip = { state: 'not_measured'; reason: 'too_large' | 'multiple_sections' } | {
  state: 'measured'; R1: { sourceLines: number; outputLines: number; matched: number; residualMatched: number; missing: number; added: number; fixedLines: number; omittedLines: number; pairs: Array<RefPair & { sourceLine: number; outputLine: number }>; missingLines: Array<{ ref: string; line: number }>; addedLines: Array<{ ref: string; line: number }> };
  R3: { byKind: Record<string, { source: number; output: number; matched: number; mismatched: number }>; mismatches: Difference[]; mismatchCount: number };
  R4: { sourceBlocks: number; outputBlocks: number; matched: number; omitted: number; normalizedSourceSpacers: number; normalizedOutputSpacers: number; unexplained: number; pairs: RefPair[]; missingBlocks: string[]; addedBlocks: string[]; differences: Difference[] };
  truncated: boolean; omittedItems: Record<string, number>;
};

/** Hirschberg LCS: two rows of scratch space; no quadratic matrix. */
export function lcsPairs(a: string[], b: string[], signal?: AbortSignal): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  function row(a0: number, a1: number, b0: number, b1: number, reverse: boolean): Uint32Array {
    const n = b1 - b0; let previous = new Uint32Array(n + 1), current = new Uint32Array(n + 1);
    for (let i = 0; i < a1 - a0; i++) {
      signal?.throwIfAborted(); current[0] = 0;
      for (let j = 1; j <= n; j++) current[j] = a[reverse ? a1 - 1 - i : a0 + i] === b[reverse ? b1 - j : b0 + j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
      [previous, current] = [current, previous];
    }
    return previous;
  }
  function visit(a0: number, a1: number, b0: number, b1: number) {
    signal?.throwIfAborted();
    if (a0 === a1 || b0 === b1) return;
    if (a1 - a0 === 1) { for (let j = b0; j < b1; j++) if (a[a0] === b[j]) { out.push([a0, j]); break; } return; }
    const mid = (a0 + a1) >>> 1;
    let split = b0;
    // Release rows before recursing. On a tie favor matching earlier source
    // blocks; single-source leaves always take the earliest output occurrence.
    { const left = row(a0, mid, b0, b1, false), right = row(mid, a1, b0, b1, true); let best = -1;
      for (let j = 0; j <= b1 - b0; j++) { const score = left[j] + right[b1 - b0 - j]; if (score > best || score === best && left[j] > left[split - b0]) { best = score; split = b0 + j; } }
    }
    visit(a0, mid, b0, split); visit(mid, a1, split, b1);
  }
  visit(0, a.length, 0, b.length); return out;
}
function blocks(source: StructureSource): Block[] {
  const facts = structureBlocks(source), elementRefs = new Map([...source.indexed.elements].map(([r, e]) => [e, r]));
  let page = 0;
  return facts.map((fact, index) => {
    if (index === 0 || fact.pageBreak) page++;
    const e = source.indexed.elements.get(fact.ref)!;
    const paragraphs = [e, ...descendants(e, 'p', NS.para)].filter(p => is(p, 'p', NS.para));
    const lines = paragraphs.flatMap(p => paragraphText(p).split(/\r?\n/).map((t, i) => ({ ref: elementRefs.get(p) ?? fact.ref, line: i, key: normalized(t) })).filter(l => l.key));
    const pics = fact.objects.filter(o => o.kind === 'pic');
    const text = normalized(paragraphText(e));
    let key: string;
    if (fact.table) {
      const tbl = source.indexed.elements.get(fact.table.ref)!;
      key = `table:${canonicalDigest({ rows: fact.table.rows, cols: fact.table.cols, cells: fact.table.cells.map(c => ({ row: c.row, col: c.col, rowSpan: c.rowSpan, colSpan: c.colSpan, text: canonicalDigest(descendants(source.indexed.elements.get(c.ref)!, 'p', NS.para).filter(p => ancestor(p, 'tc') === source.indexed.elements.get(c.ref)).map(paragraphText).map(normalized)) })), nested: descendants(tbl, 'tbl', NS.para).length })}`;
    } else if (pics.length) key = `picture:${canonicalDigest(pics.map(o => ({ sha256: o.assetSha256 ?? 'unresolved', treatAsChar: o.treatAsChar })))}:${text}`;
    else if (text) key = `text:${text}`;
    else if (fact.controls.length) key = `controls:${fact.controls.map(c => c.kind).join(',')}`;
    else key = 'spacer';
    return { ref: fact.ref, key, page, spacer: key === 'spacer', controls: fact.controls, lines };
  });
}
export async function measureRoundTrip(sampleBytes: Uint8Array, outputBytes: Uint8Array, allowed: { omitted_refs: string[] }, fixedRefs: string[] = [], signal?: AbortSignal, observe?: (result: Extract<RoundTrip, { state: 'measured' }>) => Promise<void>): Promise<RoundTrip> {
  const source = await readStructureSource(sampleBytes, signal), output = await readStructureSource(outputBytes, signal);
  if (source.sectionCount !== 1 || output.sectionCount !== 1) return { state: 'not_measured', reason: 'multiple_sections' };
  if (source.indexed.nodes.filter(n => n.topLevelOrder !== null).length > 5000 || output.indexed.nodes.filter(n => n.topLevelOrder !== null).length > 5000) return { state: 'not_measured', reason: 'too_large' };
  const a = blocks(source), physicalOutput = blocks(output);
  const normalizedFirst = splitFirstParagraphMerge(a, physicalOutput), b = normalizedFirst.blocks;
  const sourceLines = a.reduce((n, v) => n + v.lines.length, 0), outputLines = b.reduce((n, v) => n + v.lines.length, 0);
  if (sourceLines > 20000 || outputLines > 20000) return { state: 'not_measured', reason: 'too_large' };
  const pairs = lcsPairs(a.map(v => v.key), b.map(v => v.key), signal), seenA = new Set(pairs.map(p => p[0])), seenB = new Set(pairs.map(p => p[1]));
  const missing = a.filter((_, i) => !seenA.has(i)), added = b.filter((_, i) => !seenB.has(i));
  const omitted = new Set(allowed.omitted_refs), fixed = new Set(fixedRefs);
  const r1: Extract<RoundTrip, { state: 'measured' }>['R1'] = { sourceLines, outputLines, fixedLines: a.filter(v => fixed.has(v.ref)).reduce((n, v) => n + v.lines.length, 0), omittedLines: a.filter(v => omitted.has(v.ref)).reduce((n, v) => n + v.lines.length, 0), ...measureLineCorrespondence(a, b, pairs, lcsPairs, signal) };
  const differences: Difference[] = [];
  for (const v of missing) if (!omitted.has(v.ref) && !v.spacer) differences.push({ kind: 'block', sourceRef: v.ref, outputRef: null, reason: 'unmatched_source' });
  // Only output paragraphs with no text, objects or controls are renderer spacers.
  for (const v of added) if (!v.spacer) differences.push({ kind: 'block', sourceRef: null, outputRef: v.ref, reason: 'unmatched_output' });
  const pageMap = new Map<number, Set<number>>();
  for (const [i, j] of pairs) { const pages = pageMap.get(a[i].page) ?? new Set(); pages.add(b[j].page); pageMap.set(a[i].page, pages); }
  const byKind: Extract<RoundTrip, { state: 'measured' }>['R3']['byKind'] = {};
  const controlsA = a.flatMap((v, i) => v.controls.map(c => ({ ...c, top: i, page: v.page })));
  const controlsB = b.flatMap((v, i) => v.controls.map(c => ({ ...c, top: i, page: v.page })));
  const used = new Set<number>(), mismatches: Difference[] = [];
  const pairMap = new Map(pairs);
  for (const c of [...controlsA, ...controlsB]) byKind[c.kind] ??= { source: 0, output: 0, matched: 0, mismatched: 0 };
  for (const c of controlsB) byKind[c.kind].output++;
  const sectionKinds = new Set(['header', 'footer', 'secPr', 'colPr']);
  for (const c of controlsA) {
    const count = byKind[c.kind]; count.source++;
    const candidates = controlsB.map((d, i) => ({ d, i })).filter(({ d, i }) => !used.has(i) && d.kind === c.kind);
    const attributes = candidates.filter(({ d }) => canonicalDigest(d.attributes) === canonicalDigest(c.attributes));
    const location = ({ d }: typeof candidates[number]) => sectionKinds.has(c.kind) ? (c.top === 0) === (d.top === 0) : ['pageNum', 'pageNumCtrl', 'newNum', 'pageHiding'].includes(c.kind) ? pageMap.get(c.page)?.has(d.page) === true : pairMap.get(c.top) === d.top;
    const match = attributes.find(location);
    if (match) { used.add(match.i); count.matched++; continue; }
    const other = attributes[0] ?? candidates[0]; if (other) used.add(other.i);
    count.mismatched++;
    mismatches.push({ kind: c.kind, sourceRef: c.ownerRef, outputRef: other?.d.ownerRef ?? null, reason: !other ? 'missing_control' : !attributes.length ? 'attributes' : 'applied_page' });
  }
  for (const [i, c] of controlsB.entries()) if (!used.has(i)) { byKind[c.kind].mismatched++; mismatches.push({ kind: c.kind, sourceRef: null, outputRef: c.ownerRef, reason: 'added_control' }); }
  const result: RoundTrip = { state: 'measured', R1: r1, R3: { byKind, mismatches, mismatchCount: mismatches.length }, R4: { sourceBlocks: a.length, outputBlocks: physicalOutput.length, matched: pairs.length, omitted: missing.filter(v => omitted.has(v.ref)).length, normalizedSourceSpacers: missing.filter(v => !omitted.has(v.ref) && v.spacer).length, normalizedOutputSpacers: added.filter(v => v.spacer).length, unexplained: differences.length, pairs: pairs.map(([i, j]) => ({ sourceRef: a[i].ref, outputRef: b[j].ref })), missingBlocks: missing.map(v => v.ref), addedBlocks: added.map(v => v.ref), differences: [...normalizedFirst.allowed, ...differences] }, truncated: false, omittedItems: {} };
  if (observe) await observe(result);
  return boundRoundTrip(result);
}
/** Keep aggregates exact, clip only list tails; reserve space for preview fields. */
export function boundRoundTrip(result: Extract<RoundTrip, { state: 'measured' }>, budget = 192 * 1024): RoundTrip {
  const lists: Record<string, unknown[]> = { 'R1.pairs': result.R1.pairs, 'R1.missingLines': result.R1.missingLines, 'R1.addedLines': result.R1.addedLines, 'R3.mismatches': result.R3.mismatches, 'R4.pairs': result.R4.pairs, 'R4.missingBlocks': result.R4.missingBlocks, 'R4.addedBlocks': result.R4.addedBlocks, 'R4.differences': result.R4.differences };
  for (const key of Object.keys(lists)) result.omittedItems[key] ??= 0;
  while (Buffer.byteLength(JSON.stringify(result), 'utf8') > budget) {
    const [key, list] = Object.entries(lists).sort((x, y) => y[1].length - x[1].length)[0];
    if (!list.length) break;
    const remove = Math.max(1, Math.ceil(list.length / 4)); list.splice(list.length - remove, remove); result.omittedItems[key] += remove; result.truncated = true;
  }
  return result;
}
