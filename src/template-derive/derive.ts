import { resolveFixedRanges, type RangeReplacement } from './bundleValidation';
import { parseDeriveBundleV3, type DeriveBundleV3 } from './deriveBundleV3';
import { hierarchyRule } from './hierarchyRule';
import type { Document, Element } from '@xmldom/xmldom';
import { parseAnyProfileNote } from './profile';
import { derivationDigestV2, styleSources } from './profileV2';
import { derivationDigest, validateStyleJson } from './schema';
import { byteDigest } from './digest';
import type { FixedRegion, NodeRef } from './types';
import { Guard, LIMITS, StyleError } from './limits';
import { readBoundedZip } from './boundedZip';
import { children, descendants, first, is, NS, parseXml } from './xml';
import { allElements, ancestor, canonicalPrefixes, indexSection, serialize } from './dom';
import { isNumberToken } from '../hwpx/numberToken';
import { collectAssets, newPackageManifest, packageBytes, sanitizeHeader } from './sanitizePackage';
import { markerInventory, payloadDigest, readProvenance, writeProvenance } from './provenance';
import { assertSupportedFragment, assertSupportedSection, validateReferences } from './validate';
import { inspectTemplateXml } from '../templateInspector';
import { parseVariantMarker } from './variantMarkers';
import { spaceMarkerParts } from '../contextSpacers';
import { BODY_START_MARKER, RECORD_MARKER, fixedRegionRoots, readDecompositionRecord, templatePayloadSha256, writeDecompositionRecord, type DecompositionRecordInput } from './decompositionRecord';
import { dominantRun } from './structure';
import { wrapHeadingBoxRule } from './headingBoxRule';
import { ensureRuleBorder } from './ruleBorder';

export const DERIVATION_MARKERS = ['BODY', 'CODE', 'QUOTE', 'HR', ...Array.from({ length: 9 }, (_, index) => `H${index + 1}`), 'CAPTION', 'FOOTNOTE', 'CELL_BODY', ...['HEADER', 'TOP', 'MIDDLE', 'BOTTOM'].flatMap(row => ['LEFT', 'CENTER', 'RIGHT'].map(column => `CELL_${row}_${column}`)), 'CELL_NUMBER', 'CELL_STUB', 'CELL_ODD', 'CELL_EVEN', ...['ODD', 'EVEN'].flatMap(row => ['LEFT', 'CENTER', 'RIGHT'].map(column => `CELL_${row}_${column}`))];
export function validDerivationMarker(marker: string): boolean { return ![...marker].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) && (DERIVATION_MARKERS.includes(marker) || marker === 'TABLE_CAPTION' || !!parseVariantMarker(marker) || !!spaceMarkerParts(marker) || /^[^A-Za-z{}<>\r\n][^{}<>\r\n]{0,15}$/.test(marker)); }
export function ownText(paragraph: Element): string { return allElements(paragraph).filter(node => is(node, 't', NS.para) && ancestor(node, 'p') === paragraph).map(node => node.textContent ?? '').join(''); }
const SPACER_CHILD_NAMES = new Set(['run', 't', 'linesegarray', 'lineseg']);
/** A paragraph with no text and nothing but text runs: the blank line an author inserts above a paragraph for vertical space. */
export function isSpacerParagraph(paragraph: Element): boolean {
  return ownText(paragraph) === '' && allElements(paragraph).every(node => node.namespaceURI === NS.para && SPACER_CHILD_NAMES.has(node.localName ?? ''));
}
const MAX_LEADING_SPACERS = 4;
/** The blank paragraphs directly above a paragraph, in document order. */
export function leadingSpacers(paragraph: Element, limit = MAX_LEADING_SPACERS): Element[] {
  const result: Element[] = [];
  for (let node = paragraph.previousSibling; node && result.length < limit; node = node.previousSibling) {
    if (node.nodeType !== 1) continue;
    const element = node as Element;
    if (!is(element, 'p', NS.para) || !isSpacerParagraph(element)) break;
    result.unshift(element);
  }
  return result;
}
function replaceText(paragraph: Element, value: string) {
  const leaves = allElements(paragraph).filter(node => is(node, 't', NS.para) && ancestor(node, 'p') === paragraph);
  if (!leaves.length) throw new StyleError('unsupported', 'Selected paragraph has no text leaf.');
  for (const leaf of leaves) while (leaf.firstChild) leaf.removeChild(leaf.firstChild);
  leaves[0].appendChild(paragraph.ownerDocument!.createTextNode(value));
}
function make(document: Document, tag: string, attrs: Record<string, string | number> = {}, content: Element[] = []): Element {
  const node = document.createElementNS(NS.para, `hp:${tag}`); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value)); for (const child of content) node.appendChild(child); return node;
}
function cleanParagraphAttributes(paragraph: Element): void {
  const paragraphAttributes = new Set(['id', 'paraPrIDRef', 'styleIDRef', 'pageBreak', 'columnBreak', 'merged']);
  for (const attribute of Array.from(paragraph.attributes)) if (!paragraphAttributes.has(attribute.name)) paragraph.removeAttributeNode(attribute);
}
function cleanParagraph(document: Document, source: Element, marker = '', bindingMarker?: string): Element {
  const p = document.importNode<Element>(source, false);
  cleanParagraphAttributes(p);
  let run = children(source).find(node => is(node, 'run', NS.para));
  if (bindingMarker === 'BODY:META') {
    const groups = new Map<string | null, { run: Element; length: number }>();
    for (const candidate of children(source).filter(node => is(node, 'run', NS.para))) {
      // Only this run's text leaves; nested footnotes/objects are not its text.
      const length = children(candidate).filter(node => is(node, 't', NS.para))
        .reduce((count, text) => count + [...(text.textContent ?? '')].length, 0);
      if (!length) continue;
      const key = candidate.getAttribute('charPrIDRef'), group = groups.get(key);
      if (group) group.length += length;
      else groups.set(key, { run: candidate, length });
    }
    // Insertion order retains the first text run for ties between style totals.
    let longest = 0;
    for (const group of groups.values())
      if (group.length > longest) { run = group.run; longest = group.length; }
  }
  const char = run?.getAttribute('charPrIDRef');
  const r = make(document, 'run', char !== null && char !== undefined ? { charPrIDRef: char } : {}), t = make(document, 't');
  for (const [index, part] of marker.split('\t').entries()) {
    if (index) t.appendChild(make(document, 'tab'));
    t.appendChild(document.createTextNode(part));
  }
  r.appendChild(t); p.appendChild(r); return p;
}
/**
 * The rule paragraph's text. A literal prefix rule ({{□}}, {{ㅇ}}) removes the
 * bullet from the Markdown paragraph on output, so the rule itself carries the
 * glyph in the sample's character style; numeric prefixes are kept by the
 * renderer and named markers take the marker alone.
 */
function ruleMarkerText(marker: string, source: Element): string {
  const literalPrefix = !/^[A-Za-z]/.test(marker) && !/^\d+\.?$/.test(marker);
  const text = allElements(source).filter(node => is(node, 't', NS.para) && ancestor(node, 'p') === source)
    .map(leaf => Array.from(leaf.childNodes).map(node => node.nodeType === 1 && is(node as Element, 'tab', NS.para) ? '\t' : node.textContent ?? '').join('')).join('');
  const indent = /^[ \t]*/.exec(text)![0];
  return literalPrefix ? `${indent}${marker}{{${marker}}}` : `{{${marker}}}`;
}
function ruleDescription(marker: string): string {
  const space = spaceMarkerParts(marker), variant = parseVariantMarker(marker);
  let label = `${marker} 문단`;
  if (marker === 'BODY') label = '본문(기호 없는 문단)';
  else if (marker === 'H1') label = '문서 제목(# 제목)';
  else if (marker === 'H2') label = '장 제목(## 제목)';
  else if (/^H[3-9]$/.test(marker)) {
    const level = Number(marker.slice(1));
    label = `제목 ${level}단계(${'#'.repeat(level)} …)`;
  } else if (variant?.base === 'BODY') label = `${variant.variant} 문단(<!-- hwpx:style=${variant.variant} -->)`;
  else if (space) label = `여백 규칙(${space.rule} 앞 블록이 ${space.previous}일 때)`;
  else if (!/^[A-Za-z_]/.test(marker)) label = `${marker} 로 시작하는 문단`;
  return `${label} — 이 규칙의 모양을 고치면 해당 문단에 적용됩니다.`;
}
function ruleTable(document: Document, source: Element, marker: string, width: number, borderFill: string, decomposition = false, hierarchyHeader?: Document, prefix = '', spacingSource?: Element): Element {
  const sourceTable = ancestor(source, 'tbl');
  if (sourceTable) {
    if (descendants(sourceTable, 'tbl', NS.para).length) throw new StyleError('unsupported', 'Nested rule-table derivation unsupported.');
    const wrapper = ancestor(sourceTable, 'p'); if (!wrapper) throw new StyleError('corrupted', 'Table wrapper missing.');
    const output = document.importNode<Element>(wrapper, true), originalParagraphs = descendants(wrapper, 'p', NS.para), copiedParagraphs = descendants(output, 'p', NS.para);
    // Preserve whole ordinal cells, not ordinal-looking fragments of labels.
    const numberCells = new Set(descendants(sourceTable, 'tc', NS.para).filter(cell =>
      isNumberToken(descendants(cell, 'p', NS.para).map(ownText).join(''))));
    for (const [index, p] of copiedParagraphs.entries()) {
      const selected = originalParagraphs[index] === source;
      const text = selected ? ruleMarkerText(marker, source)
        : numberCells.has(ancestor(originalParagraphs[index], 'tc')!) ? ownText(originalParagraphs[index]) : '';
      p.parentNode!.replaceChild(selected && hierarchyHeader ? hierarchyRule(document, originalParagraphs[index], marker, hierarchyHeader, prefix) : cleanParagraph(document, originalParagraphs[index], text, selected ? marker : undefined), p);
    }
    const copiedTable = descendants(output, 'tbl', NS.para)[0];
    if (!copiedTable) throw new StyleError('corrupted', 'Rule table disappeared.');
    copiedTable.parentNode!.removeChild(copiedTable);
    while (output.firstChild) output.removeChild(output.firstChild);
    const originalRun = children(wrapper).find(node => is(node, 'run', NS.para));
    const wrapperRun = originalRun ? document.importNode<Element>(originalRun, false) : make(document, 'run');
    wrapperRun.appendChild(copiedTable); output.appendChild(wrapperRun);
    return decomposition ? wrapHeadingBoxRule(output, sourceTable, marker, numberCells.size > 0, () => ruleTable(document, wrapper, marker, width, borderFill, decomposition, hierarchyHeader, prefix, spacingSource)) : output;
  }
  // Korean reports space paragraphs with blank paragraphs of a tuned font size
  // rather than paragraph margins. The blank lines directly above the
  // v1 representative (or the independent v3 spacing source) go into the rule
  // cell ahead of the marker. An omitted v3 source supplies no default blanks.
  const spacers = (hierarchyHeader ? (spacingSource ? leadingSpacers(spacingSource, Infinity) : []) : leadingSpacers(source, MAX_LEADING_SPACERS)).map(spacer => cleanParagraph(document, spacer));
  const p = hierarchyHeader ? hierarchyRule(document, source, marker, hierarchyHeader, prefix) : cleanParagraph(document, source, ruleMarkerText(marker, source), marker);
  const cell = make(document, 'tc', { name: '', header: 0, hasMargin: 1, protect: 0, editable: 0, dirty: 0, borderFillIDRef: borderFill }, [
    make(document, 'subList', { id: '', textDirection: 'HORIZONTAL', lineWrap: 'BREAK', vertAlign: 'TOP', linkListIDRef: 0, linkListNextIDRef: 0, textWidth: 0, textHeight: 0, hasTextRef: 0, hasNumRef: 0 }, [...spacers, p]),
    make(document, 'cellAddr', { colAddr: 0, rowAddr: 0 }), make(document, 'cellSpan', { colSpan: 1, rowSpan: 1 }), make(document, 'cellSz', { width, height: 1000 }), make(document, 'cellMargin', { left: 0, right: 0, top: 0, bottom: 0 }),
  ]);
  const table = make(document, 'tbl', { id: 0, zOrder: 0, numberingType: 'TABLE', textWrap: 'TOP_AND_BOTTOM', textFlow: 'BOTH_SIDES', lock: 0, dropcapstyle: 'None', pageBreak: 'CELL', repeatHeader: 0, rowCnt: 1, colCnt: 1, cellSpacing: 0, borderFillIDRef: borderFill, noAdjust: 0 }, [
    make(document, 'sz', { width, widthRelTo: 'ABSOLUTE', height: 1000, heightRelTo: 'ABSOLUTE', protect: 0 }), make(document, 'pos', { treatAsChar: 1, affectLSpacing: 0, flowWithText: 1, allowOverlap: 0, holdAnchorAndSO: 0, vertRelTo: 'PARA', horzRelTo: 'COLUMN', vertAlign: 'TOP', horzAlign: 'LEFT', vertOffset: 0, horzOffset: 0 }), make(document, 'outMargin', { left: 0, right: 0, top: 0, bottom: 0 }), make(document, 'inMargin', { left: 0, right: 0, top: 0, bottom: 0 }), make(document, 'tr', {}, [cell]),
  ]);
  const wrapper = cleanParagraph(document, source); wrapper.firstChild!.appendChild(table); return wrapper;
}

export async function deriveTemplate(input: { sampleBytes: Uint8Array; profileBytes: Uint8Array; expectedSampleSha256: string; expectedProfileSha256: string; signal?: AbortSignal }): Promise<{ bytes: Uint8Array; report: Record<string, unknown> }> {
  const guard = new Guard(input.signal); guard.check();
  if (byteDigest(input.sampleBytes) !== input.expectedSampleSha256 || byteDigest(input.profileBytes) !== input.expectedProfileSha256) throw new StyleError('source_changed', 'Sample/profile hash mismatch.');
  const { machine } = await parseAnyProfileNote(new TextDecoder('utf-8', { fatal: true }).decode(input.profileBytes));
  if (machine.schema === 'report-style-profile/1' && machine.bindings.some(binding => parseVariantMarker(binding.marker))) throw new StyleError('unsupported', 'Named variants require profile v2.');
  if (machine.schema === 'report-style-profile/2' && machine.roleStyleMap.some(style => {
    const parsed = parseVariantMarker(style.marker);
    return style.variant !== null ? parsed?.variant !== style.variant : !!parsed;
  })) throw new StyleError('unsupported', 'Role style variant does not match a supported marker.');
  const bindings = machine.schema === 'report-style-profile/1' ? machine.bindings : styleSources(machine.roleStyleMap);
  const digest = machine.schema === 'report-style-profile/1' ? await derivationDigest(machine) : derivationDigestV2(machine);
  if (machine.snapshot.source.format !== 'hwpx' || machine.snapshot.source.sha256 !== input.expectedSampleSha256) throw new StyleError('unsupported', 'Derivation requires a profile measured from this HWPX copy.');
  return buildDerived({ sampleBytes: input.sampleBytes, sourceSha256: input.expectedSampleSha256, bindings, fixedRegions: machine.fixedRegions, nodes: machine.snapshot.nodes, sectionCount: machine.snapshot.sections.length, digest, validateVariants: machine.schema === 'report-style-profile/2', guard, signal: input.signal });
}

/** Derive directly from a bounded, digest-bound bundle; no profile file is created. */
export async function deriveFromBindings(input: { sampleBytes: Uint8Array; bundle: unknown; signal?: AbortSignal; record?: DecompositionRecordInput }): Promise<{ bytes: Uint8Array; report: Record<string, unknown> }> {
  const guard = new Guard(input.signal); guard.check();
  const bundle = parseDeriveBundleV3(input.bundle);
  if (input.sampleBytes.byteLength > LIMITS.input) throw new StyleError('too_large', 'Sample exceeds input limit.');
  const sampleBytes = Uint8Array.from(input.sampleBytes);
  guard.check();
  if (byteDigest(sampleBytes) !== bundle.expected_sample_sha256) throw new StyleError('source_changed', 'Sample hash mismatch.');
  return buildDerived({ sampleBytes, sourceSha256: bundle.expected_sample_sha256, bindings: bundle.bindings, fixedRegions: [], bundle, digest: bundle.derivation_sha256, validateVariants: true, guard, signal: input.signal, record: input.record });
}

type DeriveSpec = { sampleBytes: Uint8Array; sourceSha256: string; bindings: { marker: string; representativeRef: string }[]; fixedRegions: FixedRegion[]; nodes?: NodeRef[]; sectionCount?: number; bundle?: DeriveBundleV3; digest: string; validateVariants: boolean; guard?: Guard; signal?: AbortSignal; record?: DecompositionRecordInput };
async function buildDerived(input: DeriveSpec): Promise<{ bytes: Uint8Array; report: Record<string, unknown> }> {
  const guard = input.guard ?? new Guard(input.signal); guard.check();
  const { bindings, digest } = input;
  if (!bindings.some(binding => binding.marker === 'BODY') || bindings.some(binding => !validDerivationMarker(binding.marker)) || new Set(bindings.map(binding => binding.marker)).size !== bindings.length) throw new StyleError('unsupported', 'Unique supported markers including BODY required.');
  for (const base of ['CAPTION', 'TABLE_CAPTION']) {
    if (bindings.some(binding => parseVariantMarker(binding.marker)?.base === base) && !bindings.some(binding => binding.marker === base))
      throw new StyleError('unsupported', `Caption variant requires base marker ${base}.`);
  }
  const zip = await readBoundedZip(input.sampleBytes, guard);
  if ([...zip.keys()].filter(name => /^Contents\/section\d+\.xml$/.test(name)).length !== 1 || (input.sectionCount !== undefined && input.sectionCount !== 1)) throw new StyleError('unsupported', 'Only single-section derivation is supported.');
  const read = async (name: string) => { const bytes = zip.get(name); if (!bytes) throw new StyleError('corrupted', 'Missing HWPX package member.'); return canonicalPrefixes(await parseXml(bytes, guard)); };
  const header = await read('Contents/header.xml'), source = await read('Contents/section0.xml'), sourcePackage = await read('Contents/content.hpf');
  if (!is(header.documentElement!, 'head', NS.head) || !is(source.documentElement!, 'sec', NS.section)) throw new StyleError('corrupted', 'Invalid semantic document root.');
  // The sample body is not checked as a whole: only the pieces copied below
  // (section properties, fixed regions, rule tables) must be supported.
  const indexed = indexSection(source.documentElement!);
  if (input.nodes && JSON.stringify(indexed.nodes) !== JSON.stringify(input.nodes)) throw new StyleError('source_changed', 'Profile/source structure mismatch.');
  const hierarchy = input.bundle?.schema === 'derive-bundle/3' ? input.bundle : undefined;
  const v2 = !!hierarchy;
  let fixedRegions: Array<{ ref: string; position: string; replacements: RangeReplacement[] }> = input.fixedRegions;
  if (input.bundle) fixedRegions = resolveFixedRanges(input.bundle, indexed.nodes);
  const section = canonicalPrefixes(source), root = section.documentElement!;
  while (root.firstChild) root.removeChild(root.firstChild);
  const firstParagraph = children(source.documentElement!).find(node => is(node, 'p', NS.para)), sectionProperties = first(source.documentElement!, 'secPr', NS.para);
  if (!firstParagraph || !sectionProperties) throw new StyleError('corrupted', 'First paragraph/section properties missing.');
  const body = bindings.find(binding => binding.marker === 'BODY')!, bodyParagraph = indexed.elements.get(body.representativeRef)!;
  const firstOutput = cleanParagraph(section, bodyParagraph), firstRun = firstOutput.firstChild!;
  firstRun.insertBefore(section.importNode(sectionProperties, true), firstRun.firstChild);
  const columns = first(source.documentElement!, 'colPr', NS.para); if (columns) firstRun.appendChild(make(section, 'ctrl', {}, [section.importNode<Element>(columns, true)]));
  // Copy only section-level header/footer/page-number controls. Keep the source
  // run grouping and character style; newNum/pageHiding belong to E4.
  const sectionControlNames = new Set(['header', 'footer', 'pageNum', 'pageNumCtrl']);
  const isSectionControl = (node: Element) => node.namespaceURI === NS.para && sectionControlNames.has(node.localName ?? '');
  const sourceRuns = children(firstParagraph).filter(node => is(node, 'run', NS.para));
  for (const [index, run] of sourceRuns.entries()) {
    const copiedRun = section.importNode<Element>(run, false);
    for (const child of children(run)) {
      if (isSectionControl(child)) copiedRun.appendChild(section.importNode(child, true));
      else if (is(child, 'ctrl', NS.para)) {
        const controls = children(child).filter(isSectionControl);
        if (!controls.length) continue;
        const copy = section.importNode<Element>(child, false);
        for (const control of controls) copy.appendChild(section.importNode(control, true));
        copiedRun.appendChild(copy);
      }
    }
    if (!copiedRun.firstChild) continue;
    if (index === 0) while (copiedRun.firstChild) firstRun.appendChild(copiedRun.firstChild);
    else firstOutput.appendChild(copiedRun);
  }
  assertSupportedFragment(firstOutput, 'section properties', ['s0'], true);
  root.appendChild(firstOutput);
  const fixed = (position: string) => fixedRegions.filter(region => region.position === position).map(region => {
    const original = indexed.elements.get(region.ref); if (!original) throw new StyleError('corrupted', 'Fixed region missing.');
    const clone = section.importNode<Element>(original, true), paragraphs = [original, ...descendants(original, 'p', NS.para)].filter(node => is(node, 'p', NS.para)), clonedParagraphs = [clone, ...descendants(clone, 'p', NS.para)].filter(node => is(node, 'p', NS.para));
    for (const replacement of region.replacements) {
      const index = paragraphs.indexOf(indexed.elements.get(replacement.paragraphRef)!); if (index < 0) throw new StyleError('corrupted', 'Meta replacement outside fixed region.');
      const p = clonedParagraphs[index], marker = `{{META:${replacement.metaKey}${replacement.format === undefined ? '' : `|format=${replacement.format}`}}}`;
      if (v2) {
        const run = dominantRun(paragraphs[index]), char = run?.getAttribute('charPrIDRef');
        replaceText(p, marker);
        const leaf = allElements(p).find(n => is(n, 't', NS.para) && ancestor(n, 'p') === p)!;
        if (char !== null && char !== undefined) ancestor(leaf, 'run')?.setAttribute('charPrIDRef', char);
      } else replaceText(p, marker);
    }
    for (const secPr of descendants(clone, 'secPr', NS.para)) secPr.parentNode!.removeChild(secPr);
    if (v2) for (const n of allElements(clone).filter(isSectionControl)) n.parentNode!.removeChild(n);
    assertSupportedFragment(clone, `fixed region ${region.ref}`, [region.ref], false, v2);
    return clone;
  });
  for (const node of fixed('before_content')) root.appendChild(node);
  let recordNode: Element | undefined;
  if (v2) {
    recordNode = cleanParagraph(section, bodyParagraph, RECORD_MARKER); root.appendChild(recordNode);
    root.appendChild(cleanParagraph(section, bodyParagraph, '목차 등 고정 영역의 글은 샘플 그대로 출력됩니다. 새 문서에서는 한글에서 고치세요.'));
    const top = indexed.nodes.filter(n => n.topLevelOrder !== null), before = fixedRegions.filter(r => r.position === 'before_content');
    const last = before.length ? top.findIndex(n => n.ref === before[before.length - 1].ref) : -1;
    const start = last + 1;
    const place = cleanParagraph(section, bodyParagraph, BODY_START_MARKER), run = place.firstChild!;
    for (let i = start; i < top.length; i++) {
      const owner = indexed.elements.get(top[i].ref)!;
      if (i > start && owner.getAttribute('pageBreak') === '1') break;
      for (const ctrl of allElements(owner).filter(n => n.namespaceURI === NS.para && ['newNum', 'pageHiding'].includes(n.localName ?? '') && ancestor(n, 'p') === owner)) run.appendChild(make(section, 'ctrl', {}, [section.importNode<Element>(ctrl, true)]));
    }
    root.appendChild(place);
  }
  const page = first(source, 'pagePr', NS.para), margin = first(page, 'margin', NS.para), width = Number(page?.getAttribute('width')) - Number(margin?.getAttribute('left')) - Number(margin?.getAttribute('right')) - Number(margin?.getAttribute('gutter'));
  if (!Number.isFinite(width) || width <= 0) throw new StyleError('unsupported', 'Measured positive page content width required.');
  const borderFill = descendants(header, 'borderFill', NS.head)[0]?.getAttribute('id'); if (!borderFill) throw new StyleError('unsupported', 'Source border definition required.');
  const ruleBorderFill = ensureRuleBorder(header);
  for (const binding of bindings) {
    await guard.tick();
    const representative = indexed.elements.get(binding.representativeRef)!;
    const headingTable = /^H[1-9]$/.test(binding.marker) ? ancestor(representative, 'tbl') : undefined;
    const owner = headingTable ? ancestor(headingTable, 'p') : undefined;
    const defaultSpace = `SPACE:${hierarchy ? binding.marker.replace(':', '/') : binding.marker}:DEFAULT`;
    if (!hierarchy && owner && leadingSpacers(owner).length && !bindings.some(item => item.marker === defaultSpace)) {
      const spacingRule = ruleTable(section, owner, defaultSpace, width, ruleBorderFill, v2, hierarchy ? header : undefined);
      assertSupportedFragment(spacingRule, `spacing for ${binding.marker}`, [binding.representativeRef]);
      if (v2) root.appendChild(cleanParagraph(section, bodyParagraph, ruleDescription(defaultSpace)));
      root.appendChild(spacingRule);
    }
    const spacerRef = hierarchy?.bindings.find(item => item.marker === binding.marker)?.leadingSpacerRef;
    const spacingSource = spacerRef === undefined ? undefined : indexed.elements.get(spacerRef);
    if (spacerRef !== undefined && (!spacingSource || !is(spacingSource, 'p', NS.para) || !leadingSpacers(spacingSource, Infinity).length)) throw new StyleError('unsupported', 'Invalid leading spacer reference.', [spacerRef]);
    if (v2) root.appendChild(cleanParagraph(section, bodyParagraph, ruleDescription(binding.marker)));
    const rule = ruleTable(section, representative, binding.marker, width, /^CELL_/.test(binding.marker) ? borderFill : ruleBorderFill, v2, hierarchy ? header : undefined, 'prefix' in binding ? binding.prefix as string : '', spacingSource);
    if (v2) for (const n of allElements(rule).filter(n => n.namespaceURI === NS.para && ['newNum', 'pageHiding'].includes(n.localName ?? ''))) n.parentNode!.removeChild(n);
    assertSupportedFragment(rule, `binding ${binding.marker} at ${binding.representativeRef}`, [binding.representativeRef]);
    root.appendChild(rule);
  }
  root.appendChild(cleanParagraph(section, bodyParagraph, '{{CONTENT}}'));
  for (const node of fixed('after_content')) root.appendChild(node);
  // One monotonically allocated paragraph/object ID space, plus exact field
  // pairing. XML cache segments are removed after every textual change.
  let id = 1; const fieldIds = new Map<string, string>();
  for (const node of allElements(section)) if (is(node, 'fieldBegin', NS.para)) { const old = node.getAttribute('id'); if (!old || fieldIds.has(old)) throw new StyleError('unsupported', 'Ambiguous field IDs.'); fieldIds.set(old, String(id++)); }
  for (const node of allElements(section).reverse()) {
    if (is(node, 'p', NS.para)) cleanParagraphAttributes(node);
    if (is(node, 'linesegarray', NS.para)) { node.parentNode!.removeChild(node); continue; }
    if (is(node, 'fieldBegin', NS.para)) { const fresh = fieldIds.get(node.getAttribute('id')!)!; node.setAttribute('id', fresh); node.setAttribute('fieldid', fresh); }
    else if (is(node, 'fieldEnd', NS.para)) { const fresh = fieldIds.get(node.getAttribute('beginIDRef') ?? ''); if (!fresh) throw new StyleError('corrupted', 'Unpaired field end.'); node.setAttribute('beginIDRef', fresh); node.setAttribute('fieldid', fresh); }
    else if (node.namespaceURI === NS.para && (is(node, 'p', NS.para) || node.hasAttribute('id') && !['subList', 'secPr', 'colPr'].includes(node.localName ?? ''))) { const fresh = String(id++); node.setAttribute('id', fresh); if (node.hasAttribute('instid')) node.setAttribute('instid', fresh); if (node.hasAttribute('instId')) node.setAttribute('instId', fresh); }
  }
  sanitizeHeader(header, section); validateReferences(header, section);
  const assets = collectAssets(section, sourcePackage, zip), manifest = newPackageManifest(assets);
  if (recordNode && input.record) {
    const pair = { ...input.record, templatePayloadSha256: templatePayloadSha256(header, section, manifest, assets) };
    writeDecompositionRecord(recordNode, { ...pair, schema: 'hwpx-decomposition-record/2', dialect: hierarchy!.dialect, rulesVersion: hierarchy!.rulesVersion, catalogVersion: hierarchy!.catalogVersion });
  }
  const inventory = markerInventory(descendants(section, 'p', NS.para).map(ownText));
  writeProvenance(manifest, input.sourceSha256, digest, inventory, payloadDigest(header, section, manifest, assets));
  const inspection = inspectTemplateXml(serialize(header), serialize(section));
  if (input.validateVariants && bindings.some(binding => parseVariantMarker(binding.marker) && !inspection.markers.some(marker => marker.marker === `{{${binding.marker}}}`))) throw new StyleError('unsupported', 'Derived variant was not recognized by the template loader.');
  if (inspection.unknownMarkers.length || !inspection.markers.some(marker => marker.marker === '{{BODY}}')) throw new StyleError('unsupported', 'Exporter could not recognize the derived rules.');
  guard.check(); const bytes = await packageBytes(header, section, manifest, assets); guard.check();
  const report = await getDerivationReport(bytes, byteDigest(bytes), input.signal);
  return { bytes, report };
}

export async function getDerivationReport(bytes: Uint8Array, expectedSha256: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (byteDigest(bytes) !== expectedSha256) throw new StyleError('source_changed', 'Derived file hash changed.');
  const guard = new Guard(signal), zip = await readBoundedZip(bytes, guard);
  const read = async (name: string) => { const data = zip.get(name); if (!data) throw new StyleError('corrupted', 'Derived package member missing.'); return parseXml(data, guard); };
  const section = await read('Contents/section0.xml'), manifest = await read('Contents/content.hpf'), header = await read('Contents/header.xml');
  assertSupportedSection(section, readDecompositionRecord(section).derivedMode ? fixedRegionRoots(section) : []); validateReferences(header, section);
  const indexed = indexSection(section.documentElement!), inventory = markerInventory(descendants(section, 'p', NS.para).map(ownText));
  const assets = collectAssets(section, manifest, zip), provenance = readProvenance(manifest, inventory, payloadDigest(header, section, manifest, assets));
  const allowed = new Set(['mimetype', 'version.xml', 'META-INF/container.xml', 'META-INF/manifest.xml', 'Contents/header.xml', 'Contents/section0.xml', 'Contents/content.hpf', ...assets.map(asset => asset.path)]);
  if ([...zip.keys()].some(path => !path.endsWith('/') && !allowed.has(path))) provenance.provenance = { state: 'unverified', reason: 'Package has additional members outside the derived resource graph.' };
  if (new TextDecoder().decode(zip.get('mimetype')) !== 'application/hwp+zip') throw new StyleError('corrupted', 'Invalid HWPX mimetype.');

  const fixedTexts = [...indexed.elements].filter(([, element]) => is(element, 'p', NS.para)).map(([ref, element]) => ({ ref, text: ownText(element) })).filter(item => item.text && !item.text.includes('{{'));
  const normalizedHeader = canonicalPrefixes(header), normalizedSection = canonicalPrefixes(section);
  const inspection = inspectTemplateXml(serialize(normalizedHeader), serialize(normalizedSection));
  const missingRoles = DERIVATION_MARKERS.filter(marker => !inventory.some(item => item.marker === marker));
  return validateStyleJson<Record<string, unknown>>('report', { missingRoles, fallbacks: inspection.fallbacks, schema: 'report-style-derivation-report/1', outputHash: expectedSha256, ...provenance, markerInventory: inventory, fixedTexts, assets: assets.map(({ path, sha256 }) => ({ path, sha256 })), unsupported: [], layout: { state: 'not_measured' } });
}
