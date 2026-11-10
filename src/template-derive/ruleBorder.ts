import type { Document, Element } from '@xmldom/xmldom';
import { children, descendants, first, is, NS } from './xml';
import { StyleError } from './limits';

/** Find a reusable visible rule border without changing the header. */
export function findRuleBorder(container: Element): string | undefined {
  const matching = children(container).filter(node => is(node, 'borderFill', NS.head)).find(node => {
    if (node.getAttribute('threeD') !== '0' || node.getAttribute('shadow') !== '0') return false;
    if (descendants(node, 'fillBrush', NS.core).length) return false;
    const direct = children(node);
    if (direct.some(child => is(child, 'slash', NS.head) || is(child, 'backSlash', NS.head) ? child.getAttribute('type') !== 'NONE' : false)) return false;
    return ['leftBorder', 'rightBorder', 'topBorder', 'bottomBorder'].every(name => {
      const side = direct.find(child => is(child, name, NS.head));
      return side?.getAttribute('type') === 'SOLID' && side.getAttribute('width') === '0.12 mm' && side.getAttribute('color') === '#000000';
    });
  });
  return matching?.getAttribute('id') || undefined;
}

/** Add a border only when the sample has no reusable definition. */
export function ensureRuleBorder(header: Document): string {
  const container = first(header, 'borderFills', NS.head);
  if (!container) throw new StyleError('unsupported', 'Source border definition required.');
  const existing = findRuleBorder(container);
  if (existing) return existing;
  const definitions = children(container).filter(node => is(node, 'borderFill', NS.head));
  const id = String(Math.max(0, ...definitions.map(node => Number(node.getAttribute('id')) || 0)) + 1);
  const make = (name: string, attrs: Record<string, string>): Element => {
    const node = header.createElementNS(NS.head, `hh:${name}`);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  };
  const border = make('borderFill', { id, threeD: '0', shadow: '0', centerLine: 'NONE', breakCellSeparateLine: '0' });
  for (const name of ['slash', 'backSlash']) border.appendChild(make(name, { type: 'NONE', Crooked: '0', isCounter: '0' }));
  for (const name of ['leftBorder', 'rightBorder', 'topBorder', 'bottomBorder']) border.appendChild(make(name, { type: 'SOLID', width: '0.12 mm', color: '#000000' }));
  border.appendChild(make('diagonal', { type: 'SOLID', width: '0.1 mm', color: '#000000' }));
  container.appendChild(border);
  container.setAttribute('itemCnt', String(children(container).filter(node => is(node, 'borderFill', NS.head)).length));
  return id;
}
