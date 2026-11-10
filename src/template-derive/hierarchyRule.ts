import type { Document, Element } from '@xmldom/xmldom';
import { StyleError } from './limits';
import { children, descendants, is, NS } from './xml';

const runText = (run: Element) => children(run).filter(n => is(n, 't', NS.para)).map(t => Array.from(t.childNodes).map(n => n.nodeType === 1 && is(n as Element, 'tab', NS.para) ? '\t' : n.textContent ?? '').join('')).join('');
/** Copy glyph/whitespace styles; the placeholder gets the non-emphasized modal style. */
export function hierarchyRule(document: Document, source: Element, marker: string, header: Document, prefix: string): Element {
  const runs = children(source).filter(n => is(n, 'run', NS.para));
  if (!runs.map(runText).join('').startsWith(prefix)) throw new StyleError('prefix_mismatch', `prefix_mismatch: representative paragraph does not start with binding prefix (${marker}).`);
  const p = document.importNode<Element>(source, false);
  const groups = new Map<string, { run: Element; count: number }>();
  let remaining = prefix.length;
  for (const run of runs) {
    const value = runText(run), skip = Math.min(remaining, value.length);
    remaining -= skip;
    if (skip) {
      const copy = document.importNode<Element>(run, false);
      let left = skip;
      for (const original of children(run).filter(n => is(n, 't', NS.para))) {
        const t = document.importNode<Element>(original, false);
        for (const child of Array.from(original.childNodes)) {
          if (!left) break;
          if (child.nodeType === 1 && is(child as Element, 'tab', NS.para)) {
            t.appendChild(document.importNode(child, true)); left--;
          } else if (child.nodeType === 3) {
            const part = (child.textContent ?? '').slice(0, left);
            t.appendChild(document.createTextNode(part)); left -= part.length;
          }
        }
        if (t.firstChild) copy.appendChild(t);
      }
      p.appendChild(copy);
    }
    const count = [...value.slice(skip).replace(/[ \t\u00a0\u3000]/gu, '')].length;
    const key = run.getAttribute('charPrIDRef') ?? '';
    const definition = descendants(header, 'charPr', NS.head).find(n => n.getAttribute('id') === key);
    const emphasized = definition && (descendants(definition, 'bold', NS.head).length || descendants(definition, 'italic', NS.head).length || descendants(definition, 'underline', NS.head).some(n => n.getAttribute('type') !== 'NONE') || descendants(definition, 'strikeout', NS.head).some(n => n.getAttribute('shape') !== 'NONE'));
    if (!count || emphasized) continue;
    const group = groups.get(key);
    if (group) group.count += count; else groups.set(key, { run, count });
  }
  const selected = [...groups.values()].sort((a, b) => b.count - a.count)[0]?.run ?? runs[0];
  const r = selected ? document.importNode<Element>(selected, false) : document.createElementNS(NS.para, 'hp:run');
  const t = document.createElementNS(NS.para, 'hp:t'); t.appendChild(document.createTextNode(`{{${marker}}}`)); r.appendChild(t); p.appendChild(r);
  return p;
}
