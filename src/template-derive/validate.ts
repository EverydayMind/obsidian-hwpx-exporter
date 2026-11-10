import { allElements, ancestor, indexSection } from './dom';
import { NS, is, children, descendants, type Document } from './xml';
import { StyleError } from './limits';

type XmlElement = import('@xmldom/xmldom').Element;
const SUPPORTED_NAMESPACES = [NS.para, NS.core, NS.section, 'http://www.hancom.co.kr/hwpml/2016/paragraph', 'http://www.hancom.co.kr/hwpml/2016/HwpUnitChar'];
const UNSUPPORTED_ELEMENTS = ['ole', 'container', 'shape', 'rect', 'line', 'ellipse', 'arc', 'polygon', 'curve', 'textart', 'equation', 'drawText', 'connectLine', 'video', 'chart', 'trackChange', 'trackChangeTag', 'autoToc', 'memo', 'masterPage'];

/** Why an element cannot be carried into a derived template, or null. */
function unsupportedReason(node: XmlElement, headerFooterOwner?: XmlElement, fixedRegion = false): string | null {
  if (node.namespaceURI && !SUPPORTED_NAMESPACES.includes(node.namespaceURI)) return 'Unknown section element namespace.';
  if (node.namespaceURI !== NS.para) return null;
  if (UNSUPPORTED_ELEMENTS.includes(node.localName ?? '')) return `Unsupported element: ${node.localName}`;
  if (is(node, 'colPr', NS.para) && node.getAttribute('colCount') !== '1') return 'Multiple columns are not yet supported for derivation.';
  if (is(node, 'pic', NS.para) || is(node, 'tbl', NS.para)) {
    const pos = children(node).find(child => is(child, 'pos', NS.para));
    const headerFooter = ancestor(node, 'header') ?? ancestor(node, 'footer');
    const inSectionHeaderFooter = headerFooterOwner && headerFooter && ancestor(headerFooter, 'p') === headerFooterOwner;
    if (pos?.getAttribute('treatAsChar') !== '1' && !inSectionHeaderFooter && !fixedRegion) return 'Floating table/image derivation unsupported.';
  }
  if (is(node, 'fieldBegin', NS.para) && node.getAttribute('type') === 'HYPERLINK') return 'External/field hyperlink derivation unsupported.';
  return null;
}

/** A whole section document (a derived template) must be supported everywhere. */
export function assertSupportedSection(document: Document, fixedRoots: XmlElement[] = []): void {
  const firstParagraph = children(document.documentElement!).find(node => is(node, 'p', NS.para));
  const refs = new Map([...indexSection(document.documentElement!).elements].map(([ref, node]) => [node, ref]));
  for (const node of allElements(document)) {
    let root = node;
    while (root.parentNode?.nodeType === 1 && root.parentNode !== document.documentElement) root = root.parentNode as XmlElement;
    const reason = unsupportedReason(node, firstParagraph, fixedRoots.includes(root));
    if (!reason) continue;
    let cursor: import('@xmldom/xmldom').Node | null = node;
    while (cursor?.nodeType === 1 && !refs.has(cursor as XmlElement)) cursor = cursor.parentNode;
    const ref = cursor ? refs.get(cursor as XmlElement) ?? 's0' : 's0';
    throw new StyleError('unsupported', `${reason} At ${ref}.`, [ref]);
  }
}

/**
 * Only content copied into the derived template must be supported. A sample's
 * own body may hold floating tables, pictures or shapes that derivation never
 * carries over (2026-11-03: a report with one floating table in its body was
 * refused outright), so each copied piece is checked with the sample ref it
 * came from.
 */
export function assertSupportedFragment(root: XmlElement, where: string, refs: string[], sectionHeaderFooter = false, fixedRegion = false): void {
  for (const node of [root, ...allElements(root)]) {
    const reason = unsupportedReason(node, sectionHeaderFooter ? root : undefined, fixedRegion);
    if (reason) throw new StyleError('unsupported', `${reason} In ${where}.`, refs);
  }
}
export function validateReferences(header: Document, section: Document): void {
  const maps = new Map<string, Set<string>>();
  for (const tag of ['charPr', 'paraPr', 'style', 'borderFill', 'numbering', 'bullet', 'tabPr']) {
    const ids = new Set<string>();
    for (const element of descendants(header, tag, NS.head)) { const id = element.getAttribute('id'); if (id === null || ids.has(id)) throw new StyleError('corrupted', 'Duplicate/missing definition ID.'); ids.add(id); }
    maps.set(tag, ids);
  }
  const referenceTypes: Record<string, string> = { charPrIDRef: 'charPr', paraPrIDRef: 'paraPr', styleIDRef: 'style', borderFillIDRef: 'borderFill', tabPrIDRef: 'tabPr' };
  for (const element of [...allElements(header), ...allElements(section)]) for (const attr of Array.from(element.attributes)) {
    const tag = referenceTypes[attr.localName ?? ''];
    // Hancom emits UINT32_MAX for a numbering/bullet head without a separate
    // character style. Preserve that sentinel only in its header definition.
    const parent = element.parentNode;
    if (tag === 'charPr' && attr.value === '4294967295' &&
        element.ownerDocument === header && is(element, 'paraHead', NS.head) &&
        parent?.nodeType === 1 && (is(parent as import('@xmldom/xmldom').Element, 'numbering', NS.head) || is(parent as import('@xmldom/xmldom').Element, 'bullet', NS.head))) continue;
    if (tag && !maps.get(tag)?.has(attr.value)) throw new StyleError('corrupted', `Unresolved ${tag} reference.`);
  }
  const ids = new Set<string>(), paragraphIds = new Set<string>();
  for (const element of allElements(section)) {
    if (!element.hasAttribute('id') || element.namespaceURI !== NS.para) continue;
    const id = element.getAttribute('id')!; if (!id || element.localName === 'subList' || element.localName === 'secPr') continue;
    const target = is(element, 'p', NS.para) ? paragraphIds : ids;
    if (target.has(id)) throw new StyleError('corrupted', 'Duplicate paragraph/object ID.'); target.add(id);
  }
  if (!descendants(section, 'secPr', NS.para).length) throw new StyleError('corrupted', 'Section properties missing.');
}
