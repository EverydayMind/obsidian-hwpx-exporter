import { byteDigest } from './digest';
import { paragraphText, readStructureSource, structureBlocks } from './structure';
import { type RoundTrip } from './roundTrip';
import { descendants, NS } from './xml';
import { children } from './xml';
import { isSpacerParagraph, leadingSpacers } from './derive';

/** Evidence for exact host-side declared transformations. No source text leaves preview. */
export async function comparisonEvidence(result: RoundTrip, sample: Uint8Array, output: Uint8Array, signal?: AbortSignal, omittedRefs: string[] = []) {
  if (result.state !== 'measured') return { unmatchedText: [], spacingDifferences: [] };
  const source = await readStructureSource(output, signal);
  const original = await readStructureSource(sample, signal);
  const unmatchedText = result.R4.addedBlocks.flatMap(ref => {
    const node = source.indexed.elements.get(ref);
    if (!node || node.localName !== 'p' || descendants(node, 'tbl', NS.para).length || descendants(node, 'pic', NS.para).length) return [];
    const text = paragraphText(node).replace(/\s+/gu, ' ').trim();
    return text ? [{ ref, textSha256: byteDigest(new TextEncoder().encode(text)) }] : [];
  });
  const sizes = (input: typeof source, ref: string) => {
    const node = input.indexed.elements.get(ref);
    if (!node || node.localName !== 'p') return [];
    return leadingSpacers(node, Infinity).map(p => {
      const run = children(p).find(n => n.localName === 'run');
      const style = descendants(input.header, 'charPr', NS.head).find(n => n.getAttribute('id') === run?.getAttribute('charPrIDRef'));
      return Number(style?.getAttribute('height')) / 100;
    });
  };
  const spacingDifferences = result.R4.pairs.flatMap(pair => {
    const node = original.indexed.elements.get(pair.sourceRef);
    if (!node || !paragraphText(node).trim() && !descendants(node, 'tbl', NS.para).length) return [];
    const sourceSizes = sizes(original, pair.sourceRef), outputSizes = sizes(source, pair.outputRef);
    return JSON.stringify(sourceSizes) === JSON.stringify(outputSizes) ? [] : [{ ...pair, sourceSizes, outputSizes }];
  });
  // Compare whole physical gaps around omitted object-only paragraphs. Ordinary
  // leading-spacing comparison stops at the object and misses its preceding blanks.
  const omitted = new Set(omittedRefs);
  const a = structureBlocks(original), b = structureBlocks(source);
  const blank = (input: typeof source, ref: string) => {
    const node = input.indexed.elements.get(ref);
    return !!node && node.localName === 'p' && isSpacerParagraph(node);
  };
  const omittedSpacingDifferences: { sourceRef: string; outputRef: string; refs: string[] }[] = [];
  const pairs = new Map(result.R4.pairs.map(p => [p.sourceRef, p.outputRef]));
  for (const pair of result.R4.pairs) {
    const end = a.findIndex(v => v.ref === pair.sourceRef);
    if (end < 0 || blank(original, pair.sourceRef) || omitted.has(pair.sourceRef)) continue;
    let start = end - 1;
    while (start >= 0 && (blank(original, a[start].ref) || omitted.has(a[start].ref))) start--;
    const gap = a.slice(start + 1, end);
    if (!gap.some(v => omitted.has(v.ref) && v.objects.length && !paragraphText(original.indexed.elements.get(v.ref)!).trim())) continue;
    const outputEnd = b.findIndex(v => v.ref === pair.outputRef);
    const outputStart = start < 0 ? -1 : b.findIndex(v => v.ref === pairs.get(a[start].ref));
    if (outputEnd < 0 || start >= 0 && outputStart < 0 || outputStart >= outputEnd) continue;
    const outputGap = b.slice(outputStart + 1, outputEnd);
    if (outputGap.some(v => !blank(source, v.ref))) continue;
    const blanks = gap.filter(v => blank(original, v.ref) && !/^s[0-9]+\/p0$/.test(v.ref));
    // The surviving suffix belongs to the next content paragraph; do not move
    // the object's preceding spacing onto it. Record only the count actually lost.
    const refs = blanks.slice(0, Math.max(0, blanks.length - outputGap.length)).map(v => v.ref);
    if (refs.length) omittedSpacingDifferences.push({ ...pair, refs });
  }
  const spacingDifferenceCount = spacingDifferences.length;
  const omittedSpacingDifferenceCount = omittedSpacingDifferences.length;
  let comparisonTruncated = false;
  while (Buffer.byteLength(JSON.stringify({ unmatchedText, spacingDifferences, omittedSpacingDifferences }), 'utf8') > 48 * 1024) {
    const list = [unmatchedText, spacingDifferences, omittedSpacingDifferences].sort((a, b) => b.length - a.length)[0];
    list.splice(-Math.max(1, Math.ceil(list.length / 4)));
    comparisonTruncated = true;
  }
  return { unmatchedText, spacingDifferences, omittedSpacingDifferences, omittedSpacingDifferenceCount, spacingDifferenceCount, comparisonTruncated };
}
