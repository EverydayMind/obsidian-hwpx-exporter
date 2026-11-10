import { DOMImplementation, XMLSerializer, type Document, type Element, type Node } from '@xmldom/xmldom';
import { children, is, NS } from './xml';
import { References } from './refs';
import type { NodeRef } from './types';
import { StyleError } from './limits';

export const OPF = 'http://www.idpf.org/2007/opf/';
const known: Record<string, string> = { [NS.para]: 'hp', [NS.head]: 'hh', [NS.core]: 'hc', [NS.section]: 'hs', [OPF]: 'opf', 'http://purl.org/dc/elements/1.1/': 'dc', 'http://www.hancom.co.kr/hwpml/2011/app': 'ha', 'http://www.hancom.co.kr/hwpml/2016/paragraph': 'hp10', 'http://www.hancom.co.kr/hwpml/2016/HwpUnitChar': 'hwpunitchar', 'http://www.hancom.co.kr/hwpml/2011/history': 'hhs' };

/** Normalize by URI so the existing Exporter scanner can consume the result. */
export function canonicalPrefixes(input: Document): Document {
  const output = new DOMImplementation().createDocument(null, '', null), namespaces = new Map<string, string>();
  const prefix = (uri: string) => { let value = namespaces.get(uri); if (!value) { value = known[uri] ?? `ns${namespaces.size}`; namespaces.set(uri, value); } return value; };
  const clone = (node: Node): Node | null => {
    if (node.nodeType === 3 || node.nodeType === 4) return output.createTextNode(node.nodeValue ?? '');
    if (node.nodeType !== 1) return null; // comments/PI are not document styling
    const element = node as Element, uri = element.namespaceURI, name = uri ? `${prefix(uri)}:${element.localName}` : element.localName ?? element.tagName;
    const copy = output.createElementNS(uri, name);
    for (const attr of Array.from(element.attributes)) {
      if (attr.namespaceURI === 'http://www.w3.org/2000/xmlns/' || attr.name === 'xmlns') continue;
      const attrUri = attr.namespaceURI, attrName = attrUri === 'http://www.w3.org/XML/1998/namespace' ? `xml:${attr.localName}` : attrUri ? `${prefix(attrUri)}:${attr.localName}` : attr.name;
      copy.setAttributeNS(attrUri, attrName, attr.value);
    }
    for (const child of Array.from(node.childNodes)) { const result = clone(child); if (result) copy.appendChild(result); }
    return copy;
  };
  const root = clone(input.documentElement!) as Element; output.appendChild(root);
  for (const [uri, name] of namespaces) root.setAttributeNS('http://www.w3.org/2000/xmlns/', `xmlns:${name}`, uri);
  return output;
}
export function serialize(document: Document): string { return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(document); }
export function allElements(root: Node): Element[] { const list: Element[] = [], stack = children(root).reverse(); while (stack.length) { const node = stack.pop()!; list.push(node); stack.push(...children(node).reverse()); } return list; }
export function indexSection(root: Element) {
  const nodes: NodeRef[] = [], refs = new References('s0', nodes), elements = new Map<string, Element>();
  const walk = (element: Element, parent: string | null, table?: string) => {
    let ref = parent;
    if (is(element, 'p', NS.para)) ref = refs.add('paragraph', parent);
    else if (is(element, 'tbl', NS.para)) { ref = refs.add('table', parent); table = ref; }
    else if (is(element, 'tc', NS.para)) {
      // Nested tables have their own cellAddr before this cell's properties.
      const address = children(element).find(node => is(node, 'cellAddr', NS.para));
      if (!table || !address) throw new StyleError('corrupted', 'Cell without address/table.');
      ref = refs.add('cell', table, `${address.getAttribute('rowAddr')}.${address.getAttribute('colAddr')}`);
    } else if (is(element, 'header', NS.para) || is(element, 'footer', NS.para)) ref = refs.add(is(element, 'header', NS.para) ? 'header' : 'footer', parent);
    if (ref !== parent && ref) elements.set(ref, element);
    for (const child of children(element)) walk(child, ref, table);
  };
  for (const child of children(root)) walk(child, null);
  return { nodes, elements };
}
export function ancestor(element: Element, local: string): Element | undefined { let node: Node | null = element.parentNode; while (node?.nodeType === 1) { if (is(node as Element, local, NS.para)) return node as Element; node = node.parentNode; } return undefined; }
