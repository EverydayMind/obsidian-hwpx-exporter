import type { Document, Element } from '@xmldom/xmldom';
import { allElements, ancestor, indexSection, OPF } from './dom';
import { byteDigest, canonicalDigest } from './digest';
import { readBoundedZip } from './boundedZip';
import { Guard, LIMITS, StyleError } from './limits';
import { children, descendants, first, is, NS, parseXml } from './xml';
import { isNumberToken } from '../hwpx/numberToken';

export const CONTROL_ATTRIBUTES: Record<string, string[]> = {
  secPr: ['textDirection', 'spaceColumns', 'tabStop', 'outlineShapeIDRef'],
  colPr: ['type', 'layout', 'colCount', 'sameSz', 'sameGap'],
  header: ['applyPageType'], footer: ['applyPageType'],
  pageNum: ['pos', 'formatType', 'sideChar'], pageNumCtrl: ['pageStartsOn', 'start', 'formatType', 'pos'],
  newNum: ['num', 'numType'], pageHiding: ['hideHeader', 'hideFooter', 'hideMasterPage', 'hideBorder', 'hideFill', 'hidePageNum'],
};
export type ControlFact = { kind: string; ownerRef: string; attributes: Record<string, string> };
export type ObjectFact = { ref: string; kind: 'pic' | 'tbl'; treatAsChar: boolean; assetSha256?: string };
export type CellFact = { ref: string; row: number; col: number; rowSpan: number; colSpan: number; paragraphs: number; codePoints: number; counter: boolean };
export type TableFact = { ref: string; rows: number; cols: number; signature: string; cells: CellFact[] };
export type StructureBlock = { ref: string; kind: 'paragraph' | 'table_host'; pageBreak: boolean; columnBreak: boolean; controls: ControlFact[]; objects: ObjectFact[]; table?: TableFact };
export type DeriveStructure = { schema: 'derive-structure/1'; sample_sha256: string; structure_sha256: string; section_count: number; blocks: StructureBlock[]; truncated: boolean; omitted_blocks: number };
export const paragraphText = (p: Element): string => allElements(p).filter(n => is(n, 't', NS.para) && ancestor(n, 'p') === p).map(n => n.textContent ?? '').join('');
export function dominantRun(p: Element): Element | undefined {
  const groups = new Map<string, { run: Element; count: number }>();
  for (const run of children(p).filter(n => is(n, 'run', NS.para))) {
    const count = children(run).filter(n => is(n, 't', NS.para)).reduce((sum, t) => sum + [...(t.textContent ?? '')].length, 0);
    const key = run.getAttribute('charPrIDRef') ?? '', group = groups.get(key);
    if (group) group.count += count; else groups.set(key, { run, count });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count)[0]?.run;
}
export async function readStructureSource(bytes: Uint8Array, signal?: AbortSignal) {
  const guard = new Guard(signal); guard.check();
  if (bytes.byteLength > LIMITS.input) throw new StyleError('too_large', 'Sample exceeds input limit.');
  const frozen = Uint8Array.from(bytes), zip = await readBoundedZip(frozen, guard);
  const sectionNames = [...zip.keys()].filter(n => /^Contents\/section\d+\.xml$/.test(n)).sort();
  const read = async (name: string) => { const data = zip.get(name); if (!data) throw new StyleError('corrupted', `Missing ${name}.`); return parseXml(data, guard); };
  const section = await read('Contents/section0.xml'), header = await read('Contents/header.xml'), manifest = await read('Contents/content.hpf');
  const indexed = indexSection(section.documentElement!);
  const assetHashes = new Map<string, string>();
  for (const item of descendants(manifest, 'item', OPF)) {
    const href = item.getAttribute('href') ?? '', path = href.replace(/^(?:\.\.\/|\/)/, '');
    if (/^BinData\/[^/]+$/.test(path) && zip.has(path)) assetHashes.set(item.getAttribute('id') ?? '', byteDigest(zip.get(path)!));
  }
  return { zip, section, header, manifest, indexed, assetHashes, sectionCount: sectionNames.length, sampleSha256: byteDigest(frozen) };
}
export type StructureSource = Awaited<ReturnType<typeof readStructureSource>>;
function styleTree(n: Element | undefined): unknown {
  return n ? { name: [n.namespaceURI, n.localName], attributes: Object.fromEntries(Array.from(n.attributes).filter(a => a.name !== 'id' && a.name !== 'xmlns' && a.prefix !== 'xmlns').map(a => [a.localName ?? a.name, a.value])), children: children(n).map(styleTree) } : null;
}
export function structureBlocks(source: StructureSource): StructureBlock[] {
  const { indexed, header, assetHashes } = source;
  const refs = new Map([...indexed.elements].map(([ref, e]) => [e, ref]));
  const definition = (tag: string, id: string | null) => descendants(header, tag, NS.head).find(n => n.getAttribute('id') === id);
  return indexed.nodes.filter(n => n.topLevelOrder !== null).map(node => {
    const element = indexed.elements.get(node.ref)!;
    const controls = allElements(element).filter(n => n.namespaceURI === NS.para && Object.prototype.hasOwnProperty.call(CONTROL_ATTRIBUTES, n.localName ?? '')).map(n => ({ kind: n.localName!, ownerRef: refs.get(ancestor(n, 'p')!) ?? node.ref, attributes: Object.fromEntries(CONTROL_ATTRIBUTES[n.localName!].filter(k => n.hasAttribute(k)).map(k => [k, n.getAttribute(k)!])) }));
    const objectNodes = allElements(element).filter(n => is(n, 'pic', NS.para) || is(n, 'tbl', NS.para));
    const objects: ObjectFact[] = objectNodes.map((n, i) => {
      const pic = is(n, 'pic', NS.para), id = first(n, 'img', NS.core)?.getAttribute('binaryItemIDRef') ?? '';
      return { ref: refs.get(n) ?? `${node.ref}/object${i}`, kind: pic ? 'pic' : 'tbl', treatAsChar: children(n).find(c => is(c, 'pos', NS.para))?.getAttribute('treatAsChar') === '1', ...(pic && assetHashes.has(id) ? { assetSha256: assetHashes.get(id)! } : {}) };
    });
    const tbl = objectNodes.find(n => is(n, 'tbl', NS.para) && ancestor(n, 'p') === element);
    let table: TableFact | undefined;
    if (tbl) {
      const cells = descendants(tbl, 'tc', NS.para).filter(c => ancestor(c, 'tbl') === tbl);
      const signature = cells.map(c => {
        const paragraphs = descendants(c, 'p', NS.para).filter(p => ancestor(p, 'tc') === c);
        return { width: children(c).find(n => is(n, 'cellSz', NS.para))?.getAttribute('width') ?? null, border: styleTree(definition('borderFill', c.getAttribute('borderFillIDRef'))), paragraphs: paragraphs.map(p => ({ paragraph: styleTree(definition('paraPr', p.getAttribute('paraPrIDRef'))), character: styleTree(definition('charPr', dominantRun(p)?.getAttribute('charPrIDRef') ?? null)) })) };
      });
      table = { ref: refs.get(tbl)!, rows: Number(tbl.getAttribute('rowCnt')), cols: Number(tbl.getAttribute('colCnt')), signature: canonicalDigest(signature), cells: cells.map(c => {
        const address = children(c).find(n => is(n, 'cellAddr', NS.para)), span = children(c).find(n => is(n, 'cellSpan', NS.para));
        const paragraphs = descendants(c, 'p', NS.para).filter(p => ancestor(p, 'tc') === c), text = paragraphs.map(paragraphText).join('');
        return { ref: refs.get(c)!, row: Number(address?.getAttribute('rowAddr')), col: Number(address?.getAttribute('colAddr')), rowSpan: Number(span?.getAttribute('rowSpan') ?? 1), colSpan: Number(span?.getAttribute('colSpan') ?? 1), paragraphs: paragraphs.length, codePoints: [...text].length, counter: isNumberToken(text) };
      }) };
    }
    return { ref: node.ref, kind: tbl ? 'table_host' : 'paragraph', pageBreak: element.getAttribute('pageBreak') === '1', columnBreak: element.getAttribute('columnBreak') === '1', controls, objects, ...(table ? { table } : {}) };
  });
}
/** Bounded wire facts, without source prose. */
export async function inspectDeriveStructure(bytes: Uint8Array, signal?: AbortSignal): Promise<DeriveStructure> {
  const source = await readStructureSource(bytes, signal);
  const all = source.sectionCount === 1 ? structureBlocks(source) : [];
  const result: DeriveStructure = { schema: 'derive-structure/1', sample_sha256: source.sampleSha256, structure_sha256: canonicalDigest(source.indexed.nodes), section_count: source.sectionCount, blocks: all.slice(0, 5000), truncated: all.length > 5000, omitted_blocks: Math.max(0, all.length - 5000) };
  while (Buffer.byteLength(JSON.stringify(result), 'utf8') > 256 * 1024 && result.blocks.length) { result.blocks.pop(); result.omitted_blocks++; result.truncated = true; }
  signal?.throwIfAborted(); return result;
}
